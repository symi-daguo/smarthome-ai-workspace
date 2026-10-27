import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  // 知识库资料：Agent 能删资料（DELETE /api/knowledge/docs/{id}），
  // 删了却没进快照就还原不回来 —— 本表有 tenantId，符合 direct 条件
  { table: 'knowledgeDoc', scope: 'direct' },
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

// ---------- 保留期（长期运行的磁盘边界） ----------

/**
 * AUTO 快照保留窗口（份/租户）。
 *
 * 为什么必须有窗口：自动快照是「破坏性操作前的整租户底」，20 张表全量 JSON，
 * 实测平均每份 10.7KB。破坏性操作越多、租户数据越大，快照总量呈**平方级**增长
 * （实测备份里 changeSnapshot 占 76.6%、80MB/7525 份），而自动底几乎从不被读 ——
 * 误删之后人来还原，用的都是最近那一份，更早的自动底是纯占位。
 *
 * 为什么是 20：够覆盖「Agent 一串操作里连续误删多次」的常见场景（20 份 ≈ 214KB，可控），
 * 又不会无限长。手动打的底（MANUAL）**不在窗口内** —— 那是用户自己留的，
 * 系统无权替他决定过期（可能存的是「上线前」这种要长期保留的版本）。
 */
export const AUTO_SNAPSHOT_KEEP = 20;

/**
 * 审计日志保留期（天）。
 *
 * 审计是只增的流水：每个写请求一行，实测单行约 513 字节。
 * 保留 90 天够回溯一个季度的事故（出险时第一动作就是查「谁动过」），
 * 再往前的价值急剧下降，而磁盘占用是线性增长的。
 */
export const AUDIT_LOG_RETENTION_DAYS = 90;

/** 单批删除条数上限：IN 列表不能无限长（PG 参数上限），一批一批删 */
const PURGE_BATCH = 500;

/** 单次清理最多跑几轮：历史积压（如首次修复前的 7000+ 份）要摊到多次请求里，别把单个请求拖死 */
const MAX_PURGE_ROUNDS = 20;

/**
 * lastUsedAt 的写入去重窗口（毫秒）。
 *
 * 取 5 分钟：lastUsedAt 只是观测数据（「这枚 Key 最近还在用吗」），
 * 5 分钟的精度完全够用；写入量从「每请求一次」降到「每 Key 每 5 分钟一次」。
 */
const APIKEY_LAST_USED_INTERVAL_MS = 5 * 60_000;

/**
 * 纯函数：从一批快照行里挑出**超出保留窗口、应当删除**的 AUTO 快照 id。
 *
 * 语义（测试就按这三条断言）：
 *   1. 只认 AUTO —— MANUAL 是用户手动留的底，**永不自动删**
 *   2. 窗口 = 最近 keep 份 AUTO；超出的最旧的先走
 *   3. 只看传入的这些行（调用方负责只取「最新的若干份」，别把整表拉进内存）
 *
 * 抽成纯函数是为了能单独证伪：窗口边界、MANUAL 保护、乱序输入都要能测。
 */
export function selectExpiredAutoSnapshotIds(
  rows: ReadonlyArray<{ id: string; trigger: string; createdAt: Date | string }>,
  keep: number,
): string[] {
  if (keep < 0) return [];
  const auto = rows
    .filter((r) => r.trigger === 'AUTO')
    // 按创建时间倒序；同刻保持入参顺序 —— 调用方是按 (createdAt desc, id desc) 取的，
    // 稳定排序会把同刻的 id 倒序也带过来，与 DB 的窗口判定保持一致
    .map((r) => ({ id: r.id, t: new Date(r.createdAt).getTime() }))
    .sort((a, b) => b.t - a.t)
    .slice(keep);
  return auto.map((r) => r.id);
}

/** 纯函数：审计保留期的截止时刻 —— 比它早的审计记录算过期。 */
export function auditRetentionCutoff(
  now: Date | number = Date.now(),
  retentionDays: number = AUDIT_LOG_RETENTION_DAYS,
): Date {
  return new Date(new Date(now).getTime() - retentionDays * 86_400_000);
}

/** 纯函数：这条审计记录是否已过保留期。 */
export function isAuditLogExpired(
  createdAt: Date | string,
  now: Date | number = Date.now(),
  retentionDays: number = AUDIT_LOG_RETENTION_DAYS,
): boolean {
  return new Date(createdAt).getTime() < auditRetentionCutoff(now, retentionDays).getTime();
}

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
  async createServiceAccount(
    tenantId: string,
    name: string,
    roleKey: string,
    actorId?: string,
  ): Promise<{
    id: string;
    name: string;
    roleKey: string;
    phone: string;
    note: string;
  }> {
    const role = await this.resolveRole(tenantId, roleKey);
    // 平台级角色（super_admin）只能由持平台级角色的人发出去。
    //
    // roleKey 可以填任意系统角色名，填 super_admin 就会建出一个平台级机器账号，
    // 它的 API Key 能调平台级接口 —— 持「成员管理」权限的角色不该有这个能力。
    // （与 team.service 建成员那道闸门同一件事。）
    if (actorId) await this.assertRoleAssignable(tenantId, role.id, actorId);

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
  /**
   * 平台级角色（Role.scope = PLATFORM）只能由持平台级角色的人分配。
   *
   * 租户级角色不看 scope：租户管理员手里的权限已经覆盖了全部 action，
   * 再按 action 比一遍只是重复判断。
   */
  private async assertRoleAssignable(tenantId: string, roleId: string, actorId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, select: { scope: true, key: true } });
    if (role?.scope !== 'PLATFORM') return;
    const memberships = await this.prisma.membership.findMany({
      where: { tenantId, userId: actorId },
      select: { role: { select: { scope: true } } },
    });
    if (!memberships.some((m) => m.role.scope === 'PLATFORM')) {
      throw new ForbiddenException(
        `PRIVILEGE_ESCALATION: 平台级角色（${role.key}）只能由平台级管理员分配`,
      );
    }
  }

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
    // lastUsedAt 是观测数据，写失败不能影响鉴权结论。
    //
    // 为什么必须去重（这是「长期运行不持续擦写硬盘」的一条主线）：
    // 原来这里是**每个**带 Key 的请求都 UPDATE 同一行。Agent 每调一次接口就写一次，
    // PG 的 HOT 更新会在同一页不断累积死元组，只能靠 VACUUM 回收 ——
    // 一天几万次调用就是几万次纯写，还把 autovacuum 拖起来持续擦盘。
    //
    // 为什么用条件 UPDATE（updateMany + where）而不是「先读 lastUsedAt 再决定写不写」：
    // 并发请求会同时读到同一个旧值，然后一起写 —— 惊群。条件更新让数据库自己判：
    // 只有「距上次写入已超过窗口」的那一次会真的改到行，并发里最多成功一个。
    const staleBefore = new Date(Date.now() - APIKEY_LAST_USED_INTERVAL_MS);
    void this.prisma.apiKey
      .updateMany({
        where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }] },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
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
    // 建完再清：窗口才始终有界。反过来（先删后加）会在某次创建前把窗口删光，
    // 那一刻恰好没有底可回滚 —— 顺序不能反。
    // 清理失败**不影响**这次快照：它已经落库了，是回滚的底，必须保住；
    // 清理只是 housekeeping，失败下轮再来。
    try {
      const purged = await this.purgeExpiredAutoSnapshots(tenantId);
      if (purged > 0) {
        this.logger.log(`AUTO 快照超出保留窗口，已清理 ${purged} 份 tenant=${tenantId} 窗口=${AUTO_SNAPSHOT_KEEP}`);
      }
    } catch (e) {
      this.logger.warn(`AUTO 快照清理失败（不影响本次快照）tenant=${tenantId}: ${String(e)}`);
    }
    return {
      id: row.id,
      label: row.label,
      counts: row.counts as unknown as Record<string, number>,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
      capabilityNote: CAPABILITY_NOTE,
    };
  }

  /**
   * 清掉该租户**超出保留窗口**的 AUTO 快照。
   *
   * 为什么挂在「创建快照之后」而不是定时器：
   *   - 定时器要额外的生命周期管理（进程重启就不跑了、多实例还得防重入），
   *     而快照本来就只在破坏性操作时产生 —— 创建点就是最自然、最可靠的触发点
   *   - 窗口是按租户算的，挂在创建路径上天然只清自己的租户，不存在跨租户误删
   *
   * 分批删：IN 列表不能无限长（PG 参数上限），一批 PURGE_BATCH 条，最多跑
   * MAX_PURGE_ROUNDS 轮。稳态下（每次只多出一份）就是「查 21 行 + 删 1 行」。
   */
  async purgeExpiredAutoSnapshots(tenantId: string): Promise<number> {
    let removed = 0;
    for (let round = 0; round < MAX_PURGE_ROUNDS; round += 1) {
      const rows = await this.prisma.changeSnapshot.findMany({
        where: { tenantId, trigger: 'AUTO' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: AUTO_SNAPSHOT_KEEP + PURGE_BATCH,
        // 只取三列：data 是整租户 JSON，拉进内存就是自己制造内存尖峰
        select: { id: true, trigger: true, createdAt: true },
      });
      const expired = selectExpiredAutoSnapshotIds(rows, AUTO_SNAPSHOT_KEEP);
      if (expired.length === 0) break;
      // where 里再带一次 tenantId + trigger：AUTO —— 就算上面的选择逻辑出 bug，
      // 也**删不到别的租户**、**删不到 MANUAL**（SQL 层的双保险）
      const res = await this.prisma.changeSnapshot.deleteMany({
        where: { id: { in: expired }, tenantId, trigger: 'AUTO' },
      });
      removed += res.count;
      // 这一批没删满 → 后面已经没有更多积压，不用再查
      if (expired.length < PURGE_BATCH) break;
    }
    return removed;
  }

  /**
   * 清掉过期的审计日志（保留期 AUDIT_LOG_RETENTION_DAYS 天）。
   *
   * 按租户隔离：只删**本租户**的过期审计，外加「不属于任何租户」的系统级审计
   * （tenantId 为空的那种：请求没带租户上下文时记的）。
   * 别的租户的审计一律不动 —— 租户 A 的请求不该顺手清掉租户 B 的记录。
   *
   * 触发频率不在这里定（见 audit.interceptor.ts 的 AUDIT_PURGE_EVERY）：
   * 每个写请求都跑一次全表 DELETE 才是新的写放大，治日志反而在制造日志。
   */
  async purgeExpiredAuditLogs(tenantId: string): Promise<number> {
    const cutoff = auditRetentionCutoff();
    const own = await this.prisma.auditLog.deleteMany({ where: { tenantId, createdAt: { lt: cutoff } } });
    const system = await this.prisma.auditLog.deleteMany({ where: { tenantId: null, createdAt: { lt: cutoff } } });
    return own.count + system.count;
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
   *
   * **整段在一个事务里**：逐行 upsert + 逐表 deleteMany 若中途失败，
   * 会留下「写了一半、删了一半」的混合态 —— 那比还原失败更难收拾。
   * 事务超时给足（默认 5s 对整租户还原远远不够）。
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

    // 整段还原放进一个事务：要么全成，要么全不成
    await this.prisma.$transaction(
      async (tx) => {
        const db = tx as unknown as Record<string, {
          upsert: (a: unknown) => Promise<unknown>;
          deleteMany: (a: unknown) => Promise<{ count: number }>;
          findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
        }>;

        // 先按「父表在前」写回，保证子表 upsert 时父行已经存在
        const writeOrder = [...direct, ...children];
        for (const spec of writeOrder) {
          const rows = data[spec.table] ?? [];
          const model = db[spec.table];
          for (const row of rows) {
            await model.upsert({ where: { id: (row as { id: string }).id }, create: row, update: row });
          }
          restored[spec.table] = rows.length;
        }

        // 再删掉「快照之后才出现」的行。子表先删，否则父表删除会被外键挡住。
        if (dropNewer) {
          for (const spec of [...children, ...direct]) {
            if (spec.scope === 'direct') {
              const keep = (data[spec.table] ?? []).map((r) => String(r.id));
              const where = keep.length === 0 ? { tenantId } : { tenantId, id: { notIn: keep } };
              const res = await db[spec.table].deleteMany({ where });
              removed[spec.table] = res.count;
            } else if (spec.fk) {
              // 子表（extractedField / extractionDeficiency / reviewConfirmation / orderNote）
              // **行上没有 tenantId**，只有指向父行的外键。
              // 直接按 `notIn(快照里的父行)` 删 = 把**别的租户**挂在别的父行上的子行也删了。
              // 所以先把「本租户当前的父行 id」查出来，删除条件取交集：
              //   fk ∈ 本租户当前父行 且 fk ∉ 快照里的父行
              // 别的租户的父行 id 不在本租户集合里，永远匹配不上。
              const parentModel = db[spec.parent!];
              const currentParents = await parentModel.findMany({ where: { tenantId }, select: { id: true } });
              const currentIds = currentParents.map((r) => String(r.id));
              if (currentIds.length === 0) {
                // 本租户当前没有父行 → 本租户不可能有子行（外键约束），一条都不用删
                removed[spec.table] = 0;
                continue;
              }
              const keep = (data[spec.parent!] ?? []).map((r) => String(r.id));
              // keep 为空 = 快照里根本没有这些父行 → 本租户现有的子行全是「快照之后才有的」，全删。
              // （原来的 `in: ['__none__']` 是条永远匹配不上的假条件，等于「新建父行的子行永远删不掉」）
              const where = keep.length === 0
                ? { [spec.fk!]: { in: currentIds } }
                : { [spec.fk!]: { notIn: keep, in: currentIds } };
              const res = await db[spec.table].deleteMany({ where });
              removed[spec.table] = res.count;
            }
          }
        }

        // 标记已还原也放在事务里：失败时不能留下「标记成已还原、内容却是半截」的快照
        await tx.changeSnapshot.update({ where: { id }, data: { restoredAt: new Date() } });
      },
      // 整租户还原要写很多行，默认 5s 的交互式事务超时远远不够
      { timeout: 300_000, maxWait: 15_000 },
    );

    this.logger.warn(`快照已还原 snapshot=${id} tenant=${tenantId} actor=${tenantId} removed=${JSON.stringify(removed)}`);
    return { ok: true, restored, removed, warning: CAPABILITY_NOTE };
  }
}