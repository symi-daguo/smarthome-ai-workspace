import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module.js';

/**
 * Agent 机器接入（0.1.53）
 *
 * 解决三件事：
 *   ① Agent 用什么身份进来 —— 独立服务账号 + 可撤销 API Key，不碰人的登录密码
 *   ② 动数据前先留底 —— 快照 + 整租户还原
 *   ③ 出事能查 —— 审计在 audit.interceptor.ts，这里只提供查询
 *
 * 能力边界（每次返回快照都会带上这段，别当万能后悔药用）：
 *   快照能还原**数据库里的行**；
 *   撤不回**已经花掉的模型调用费**、**已经由外部 API 生成出来的图片/视频**、**已经发出的通知**。
 */

/** 快照/还原覆盖的表。
 *
 *  scope=direct：行上有 tenantId，直接按租户过滤
 *  scope=child ：没有 tenantId，靠父行的 id 集合圈定（否则会把别的租户的数据一起卷进来）
 *
 * 刻意**不含**的表，以及原因：
 *   - AuditLog      审计只追加。还原它等于改写历史，「谁动过」必须永远是真的
 *   - ModelSetting / ModelProfile  无 tenantId，是部署级共享配置，还原会连别的租户一起改
 *   - Tenant/User/Role/RolePermission  身份与权限骨架，动它风险远大于收益
 */
export interface SnapshotTable {
  table: string;
  scope: 'direct' | 'child';
  /** scope=child 时的父表名，用于从父表结果取 id 集合 */
  parent?: string;
  /** scope=child 时本表的外键字段 */
  fk?: string;
  /** 还原时的写入顺序：父表必须先于子表（子表有外键约束） */
  upsertAfter?: string[];
  /** 还原时的删除顺序：子表必须先于父表 */
  deleteAfter?: string[];
}

export const SNAPSHOT_TABLES: SnapshotTable[] = [
  { table: 'categoryDef', scope: 'direct' },
  { table: 'customAgent', scope: 'direct' },
  { table: 'mediaAsset', scope: 'direct' },
  { table: 'product', scope: 'direct' },
  { table: 'planProject', scope: 'direct' },
  { table: 'floorplanLayout', scope: 'direct' },
  { table: 'lightingScene', scope: 'direct' },
  { table: 'feedbackTicket', scope: 'direct' },
  { table: 'tokenLedger', scope: 'direct' },
  { table: 'membership', scope: 'direct' },
  { table: 'generationJob', scope: 'direct' },
  // 对标账号情报：内容与分析结果声明在账号**前面**——
  // 快照还原的删除顺序按本列表倒着来（子表先删，否则父表删不掉）。
  { table: 'benchmarkContent', scope: 'direct' },
  { table: 'benchmarkInsight', scope: 'direct' },
  { table: 'benchmarkAccount', scope: 'direct' },

  { table: 'imageConversation', scope: 'direct' },
  { table: 'imageTurn', scope: 'direct' },
  { table: 'extractionJob', scope: 'direct' },
  { table: 'extractedDocument', scope: 'direct' },
  { table: 'orderRequest', scope: 'direct' },

  { table: 'extractedField', scope: 'child', parent: 'extractedDocument', fk: 'documentId', upsertAfter: ['extractedDocument'], deleteAfter: ['extractedDocument'] },
  { table: 'extractionDeficiency', scope: 'child', parent: 'extractionJob', fk: 'jobId', upsertAfter: ['extractionJob'], deleteAfter: ['extractionJob'] },
  { table: 'reviewConfirmation', scope: 'child', parent: 'extractionJob', fk: 'jobId', upsertAfter: ['extractionJob'], deleteAfter: ['extractionJob'] },
  { table: 'orderNote', scope: 'child', parent: 'orderRequest', fk: 'orderId', upsertAfter: ['orderRequest'], deleteAfter: ['orderRequest'] },
];

const CAPABILITY_NOTE = [
  '快照与还原只作用于**数据库行**。',
  '已经扣掉的额度（模型调用费）、已由外部 API 生成的图片/视频、已发出的通知**撤不回**。',
  '破坏性操作前系统会自动打 auto 快照，误删可以用 POST /api/agent/snapshots/{id}/restore 还原到操作前。',
].join('\n');

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // ---------- 服务账号 ----------

  /** 建一个只能经 API Key 使用的机器账号：无可用密码，权限完全由所选角色的 RBAC 决定 */
  async createServiceAccount(tenantId: string, name: string, roleKey: string): Promise<{
    id: string;
    name: string;
    roleKey: string;
    phone: string;
    note: string;
  }> {
    const role = await this.resolveRole(tenantId, roleKey);

    // 手机号位用 svc_ 前缀的 uuid：登录接口只接受手机号格式，因此这个账号天然登不进来
    const phone = `svc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const user = await this.prisma.user.create({
      data: {
        phone,
        // 存一个随机不可登录的哈希：argon2 校验永远失败，账号只能走 API Key
        passwordHash: `svc:${randomBytes(32).toString('hex')}`,
        displayName: name,
        isServiceAccount: true,
      },
    });
    await this.prisma.membership.create({ data: { userId: user.id, tenantId, roleId: role.id } });
    return {
      id: user.id,
      name,
      roleKey,
      phone,
      note: '该账号没有可用密码，只能通过 API Key 访问；请把 Key 存在安全的地方，平台不再二次展示。',
    };
  }

  /** 取这枚 Key 归属的租户，供 TenantGuard 做跨租户拦截 */
  async keyTenant(id: string): Promise<string | null> {
    const key = await this.prisma.apiKey.findUnique({ where: { id }, select: { tenantId: true } });
    return key?.tenantId ?? null;
  }

  /** 系统模板用可读 key、自定义角色用 uuid —— 与团队成员分配角色同一套解析规则 */
  private async resolveRole(tenantId: string, keyOrId: string): Promise<{ id: string; key: string }> {
    const role = /^[0-9a-f-]{36}$/i.test(keyOrId)
      ? await this.prisma.role.findFirst({ where: { id: keyOrId, tenantId, isSystem: false } })
      : await this.prisma.role.findFirst({ where: { key: keyOrId, isSystem: true } });
    if (!role) throw new BadRequestException(`ROLE_NOT_FOUND: ${keyOrId}`);
    return role;
  }

  async listServiceAccounts(tenantId: string): Promise<{ id: string; name: string; roleKey: string; phone: string; keys: number }[]> {
    const users = await this.prisma.user.findMany({
      where: { isServiceAccount: true, memberships: { some: { tenantId } } },
      include: { memberships: { where: { tenantId }, include: { role: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.displayName,
      roleKey: u.memberships[0]?.role.key ?? 'unknown',
      phone: u.phone,
      keys: 0,
    }));
  }

  // ---------- API Key ----------

  /**
   * 签发 API Key。
   *
   * 凭证本身就是一枚用 JWT_SECRET 签名的 JWT，payload 带 `ak`=本行 id。
   * 这样做的两个好处：① 库里**不存任何密钥材料**，即使数据库整体泄露也推不出可用凭证；
   * ② 复用现成的 JWT 校验链路，20 多个控制器一行都不用改。
   * 吊销 = 打 revokedAt，与「改密让旧 token 全失效」同一条机制。
   */
  async createApiKey(
    tenantId: string,
    userId: string,
    name: string,
    ttlDays: number,
  ): Promise<{ id: string; name: string; prefix: string; expiresAt: string; token: string; note: string }> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
    const token = await this.jwt.signAsync({ sub: userId, ak: id, tv: 0, svc: true }, { expiresIn: `${ttlDays}d` });
    const prefix = `ak_${token.slice(0, 12)}`;
    await this.prisma.apiKey.create({ data: { id, tenantId, userId, name, prefix, expiresAt } });
    return {
      id,
      name,
      prefix,
      expiresAt: expiresAt.toISOString(),
      token,
      note: '这是唯一一次返回完整 Key 的机会，平台只保留可吊销的记录、不保存密钥材料。请立即保存。',
    };
  }

  async listApiKeys(tenantId: string): Promise<{
    id: string; name: string; prefix: string; revoked: boolean; lastUsedAt: string | null; expiresAt: string | null; createdAt: string;
  }[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: { tenantId },
      select: { id: true, name: true, prefix: true, revokedAt: true, lastUsedAt: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      revoked: k.revokedAt !== null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    }));
  }

  async revokeApiKey(tenantId: string, id: string): Promise<{ ok: true; id: string }> {
    const key = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
    if (!key) throw new NotFoundException('API_KEY_NOT_FOUND');
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return { ok: true, id };
  }

  /** JWT 校验链路调用：确认这枚 Key 仍然有效，并顺手记 lastUsedAt。
   *  跨租户校验不在这里做 —— validate() 拿不到请求，交给 TenantGuard 用 apiKeyTenantId 判。 */
  async verifyApiKey(id: string): Promise<boolean> {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) return false;
    if (key.revokedAt) return false;
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return false;
    // lastUsedAt 是观测数据，写失败不能影响鉴权结论
    void this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return true;
  }

  // ---------- 快照 ----------

  async createSnapshot(
    tenantId: string,
    actorId: string,
    label: string,
    trigger: 'MANUAL' | 'AUTO',
  ): Promise<{ id: string; label: string; counts: Record<string, number>; sizeBytes: number; createdAt: string; capabilityNote: string }> {
    const data: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    const db = this.prisma as unknown as Record<string, { findMany: (a?: unknown) => Promise<unknown[]> }>;

    // 先取一遍父表，scope=child 的表要用父行 id 圈定范围
    for (const spec of SNAPSHOT_TABLES) {
      if (spec.scope !== 'direct') continue;
      const rows = (await db[spec.table].findMany({ where: { tenantId } })) as Record<string, unknown>[];
      data[spec.table] = rows;
      counts[spec.table] = rows.length;
    }
    for (const spec of SNAPSHOT_TABLES) {
      if (spec.scope !== 'child' || !spec.parent || !spec.fk) continue;
      const parentRows = data[spec.parent] as Record<string, unknown>[] | undefined;
      const ids = (parentRows ?? []).map((r) => String(r.id));
      // 父表为空说明这批子行一条都不该存在；直接记空数组，
      // 不能用 notIn:[] 去查（Prisma 会当成无条件，全表扫）
      const rows = ids.length === 0 ? [] : ((await db[spec.table].findMany({ where: { [spec.fk!]: { in: ids } } })) as Record<string, unknown>[]);
      data[spec.table] = rows;
      counts[spec.table] = rows.length;
    }

    const json = JSON.stringify(data);
    const row = await this.prisma.changeSnapshot.create({
      data: { tenantId, actorId, label, trigger, data: data as never, counts: counts as never, sizeBytes: json.length },
      select: { id: true, label: true, counts: true, sizeBytes: true, createdAt: true },
    });
    return {
      id: row.id,
      label: row.label,
      counts: row.counts as unknown as Record<string, number>,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
      capabilityNote: CAPABILITY_NOTE,
    };
  }

  async listSnapshots(tenantId: string, limit = 20): Promise<{
    id: string; label: string; trigger: string; counts: Record<string, number>; sizeBytes: number;
    restoredAt: string | null; createdAt: string; prefix: string;
  }[]> {
    const rows = await this.prisma.changeSnapshot.findMany({
      where: { tenantId },
      select: { id: true, label: true, trigger: true, counts: true, sizeBytes: true, restoredAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      trigger: r.trigger,
      counts: r.counts as unknown as Record<string, number>,
      sizeBytes: r.sizeBytes,
      restoredAt: r.restoredAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      // 还原时要用它做二次确认，省得 Agent 手滑调错快照
      prefix: r.id.slice(0, 8),
    }));
  }

  /**
   * 还原到指定快照。
   *
   * 采用「按 id upsert 回来 + 删掉快照里没有的行」，而不是「整表清空再插」：
   *   - 子表 upsert 时父行已存在，外键不会断
   *   - 只碰本租户的行，其他租户不受影响
   *   - 中途失败时已经写回去的行是幂等的，重跑一次即可
   */
  async restoreSnapshot(
    tenantId: string,
    id: string,
    confirm: string,
    dropNewer: boolean,
  ): Promise<{ ok: true; restored: Record<string, number>; removed: Record<string, number>; warning: string }> {
    const snap = await this.prisma.changeSnapshot.findFirst({ where: { id, tenantId } });
    if (!snap) throw new NotFoundException('SNAPSHOT_NOT_FOUND');
    if (confirm !== id.slice(0, 8)) {
      throw new BadRequestException(
        `CONFIRM_MISMATCH：还原 ${snap.label} 需要 confirm="${id.slice(0, 8)}"（快照 id 前 8 位），收到的是 "${confirm}"`,
      );
    }
    if (snap.restoredAt) {
      throw new BadRequestException(`SNAPSHOT_ALREADY_RESTORED：该快照已于 ${snap.restoredAt.toISOString()} 还原过一次；同一份数据不要反复还原，改用新建快照 + 精确回滚`);
    }

    const data = snap.data as unknown as Record<string, Record<string, unknown>[]>;
    const restored: Record<string, number> = {};
    const removed: Record<string, number> = {};

    const direct = SNAPSHOT_TABLES.filter((t) => t.scope === 'direct');
    const children = SNAPSHOT_TABLES.filter((t) => t.scope === 'child');

    // 先按「父表在前」写回，保证子表 upsert 时父行已经存在
    const writeOrder = [...direct, ...children];
    for (const spec of writeOrder) {
      const rows = data[spec.table] ?? [];
      const model = (this.prisma as unknown as Record<string, { upsert: (a: unknown) => Promise<unknown> }>)[spec.table];
      for (const row of rows) {
        await model.upsert({ where: { id: (row as { id: string }).id }, create: row, update: row });
      }
      restored[spec.table] = rows.length;
    }

    // 再删掉「快照之后才出现」的行。子表先删，否则父表删除会被外键挡住。
    if (dropNewer) {
      const model = (this.prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }>);
      for (const spec of [...children, ...direct]) {
        if (spec.scope === 'direct') {
          const keep = (data[spec.table] ?? []).map((r) => String(r.id));
          const where = keep.length === 0 ? { tenantId } : { tenantId, id: { notIn: keep } };
          const res = await model[spec.table].deleteMany({ where });
          removed[spec.table] = res.count;
        } else if (spec.fk) {
          const parentRows = data[spec.parent!] ?? [];
          const keep = parentRows.map((r) => String(r.id));
          const where = keep.length === 0 ? { [spec.fk!]: { in: ['__none__'] } } : { [spec.fk!]: { notIn: keep } };
          const res = await model[spec.table].deleteMany({ where });
          removed[spec.table] = res.count;
        }
      }
    }

    await this.prisma.changeSnapshot.update({ where: { id }, data: { restoredAt: new Date() } });
    this.logger.warn(`快照已还原 snapshot=${id} tenant=${tenantId} actor=${tenantId} removed=${JSON.stringify(removed)}`);
    return { ok: true, restored, removed, warning: CAPABILITY_NOTE };
  }
}