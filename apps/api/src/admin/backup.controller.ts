import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { MediaService } from '../media/media.service.js';

/**
 * 数据备份与存储治理（仅 platform:billing:manage，自部署即 tenant_admin）：
 *   - GET  /api/admin/backup        本租户的 JSON 快照下载（升级/迁移前留底；文件产物另在 uploads 卷）
 *   - GET  /api/admin/storage       产物占用统计（配额与已用）
 *   - POST /api/admin/storage/cleanup  删除 N 天前且未被方案/布局引用的产物（行+文件），防磁盘挤爆
 *
 * **备份与恢复都按租户隔离**：租户管理员拿到的是**自己租户**的数据，
 * 不是整库 —— 权限 platform:billing:manage 的本意就是「能备份自己租户的数据」。
 */

/** 一张备份表的租户范围与处理方式 */
type BackupTableSpec = {
  /** Prisma 模型名 */
  table: string;
  /**
   * 租户范围：
   *   self   这张表就是租户自己（Tenant 行）→ 按主键取
   *   own    行自带 tenantId 列 → 等值过滤
   *   child  没有 tenantId，靠父行的 id 集合圈定
   *   member 用户表，靠成员关系（Membership）圈定
   *   global 部署级表，不含任何租户业务数据 → 全量
   */
  scope: 'self' | 'own' | 'child' | 'member' | 'global';
  /** scope=child 时：父表名与本表的外键列 */
  parent?: string;
  fk?: string;
  /** replace 模式要不要先清空本租户的行（false 的都在 note 里写了原因） */
  clear: boolean;
  /** 写回方式：create=清空后原样写回 / upsert=按主键更新 / skip=不写 */
  write: 'create' | 'upsert' | 'skip';
  /** 为什么这么定 */
  note?: string;
};

/**
 * 备份表清单与每张表的租户范围。
 *
 * 为什么必须逐张声明：只有业务表上才有 tenantId 列 ——
 * 子表（orderNote / extractedField…）没有，部署级表（permission / modelSetting）也没有。
 * 不逐张说清楚，「备份」就等于把整库导出：租户管理员能下载到**别的租户**的
 * 客户手机号与方案，replace 模式还能把整库清空。
 *
 * 表的增补历史（漏掉任何一张都会让「备份」丢掉对应数据，恢复后凭空消失）：
 *   0.1.40 起新增 extractionJob/extractedDocument/extractedField/extractionDeficiency/
 *              reviewConfirmation/customAgent/feedbackTicket/lightingScene 等
 *   0.1.44 AI 画布：imageConversation/imageTurn/generationJob
 *   0.1.53 Agent 机器接入：apiKey/changeSnapshot
 *   0.1.75 本地资料库：knowledgeDoc　0.2.4 幂等记录：idempotencyRecord
 *   对标账号情报：benchmarkAccount/benchmarkContent/benchmarkInsight　方案页型配图：planPageImage
 */
const BACKUP_TABLE_SPECS: BackupTableSpec[] = [
  // 身份骨架：不删（删了会级联清掉成员关系与额度流水），只按备份内容更新
  { table: 'tenant', scope: 'self', clear: false, write: 'upsert', note: '租户行不删：删它会级联清掉成员关系与额度流水；改成按备份内容更新（名称/费率/余额）' },
  { table: 'user', scope: 'member', clear: false, write: 'upsert', note: '账号可能被多个租户共享，删用户会连带删掉别的租户的成员关系 → 只更新不删' },
  // 角色目录：只含本租户自定义角色；系统模板（tenantId=null）是部署级种子，不动
  { table: 'role', scope: 'own', clear: true, write: 'create' },
  { table: 'permission', scope: 'global', clear: false, write: 'skip', note: '动作目录是静态契约（19 个 action 由种子生成）：从上传文件写回等于允许注入新动作，不写' },
  { table: 'rolePermission', scope: 'child', parent: 'role', fk: 'roleId', clear: true, write: 'create', note: '只含本租户自定义角色的权限授予' },
  { table: 'membership', scope: 'own', clear: true, write: 'create' },
  { table: 'tokenLedger', scope: 'own', clear: true, write: 'create' },
  { table: 'auditLog', scope: 'own', clear: true, write: 'create', note: 'tenantId 可空：null 是部署级日志，不导出也不清空' },
  { table: 'extractionJob', scope: 'own', clear: true, write: 'create' },
  { table: 'extractedDocument', scope: 'own', clear: true, write: 'create' },
  { table: 'extractedField', scope: 'child', parent: 'extractedDocument', fk: 'documentId', clear: true, write: 'create' },
  { table: 'extractionDeficiency', scope: 'child', parent: 'extractionJob', fk: 'jobId', clear: true, write: 'create' },
  { table: 'reviewConfirmation', scope: 'child', parent: 'extractionJob', fk: 'jobId', clear: true, write: 'create' },
  { table: 'mediaAsset', scope: 'own', clear: true, write: 'create' },
  { table: 'planProject', scope: 'own', clear: true, write: 'create' },
  { table: 'product', scope: 'own', clear: true, write: 'create', note: '只含本租户「我的产品库」；公共库（tenantId=null）是平台种子，不动' },
  { table: 'categoryDef', scope: 'own', clear: true, write: 'create', note: '只含本租户自定义品类；平台预置 39 类不动' },
  // 部署级配置：含各服务商的 API Key，不是任何租户的数据。清空会改掉整个部署，
  // 所以只按备份内容更新（调用方本来就能用 /api/admin/model-config 改它，不是提权）。
  { table: 'modelSetting', scope: 'global', clear: false, write: 'upsert' },
  { table: 'modelProfile', scope: 'global', clear: false, write: 'upsert' },
  { table: 'floorplanLayout', scope: 'own', clear: true, write: 'create' },
  { table: 'orderRequest', scope: 'own', clear: true, write: 'create' },
  { table: 'orderNote', scope: 'child', parent: 'orderRequest', fk: 'orderId', clear: true, write: 'create' },
  { table: 'customAgent', scope: 'own', clear: true, write: 'create' },
  { table: 'feedbackTicket', scope: 'own', clear: true, write: 'create' },
  { table: 'lightingScene', scope: 'own', clear: true, write: 'create' },
  { table: 'imageConversation', scope: 'own', clear: true, write: 'create' },
  { table: 'imageTurn', scope: 'own', clear: true, write: 'create' },
  { table: 'generationJob', scope: 'own', clear: true, write: 'create' },
  { table: 'apiKey', scope: 'own', clear: true, write: 'create' },
  { table: 'changeSnapshot', scope: 'own', clear: true, write: 'create' },
  { table: 'knowledgeDoc', scope: 'own', clear: true, write: 'create' },
  { table: 'idempotencyRecord', scope: 'own', clear: true, write: 'create' },
  { table: 'benchmarkAccount', scope: 'own', clear: true, write: 'create' },
  { table: 'benchmarkContent', scope: 'own', clear: true, write: 'create' },
  { table: 'benchmarkInsight', scope: 'own', clear: true, write: 'create' },
  { table: 'planPageImage', scope: 'own', clear: true, write: 'create' },
];

/** 备份/恢复涉及的表名（按依赖顺序：父表在前） */
const BACKUP_TABLES: string[] = BACKUP_TABLE_SPECS.map((s) => s.table);

/** 表名 → 范围声明 */
const BACKUP_SPEC_BY_TABLE: Record<string, BackupTableSpec> = Object.fromEntries(
  BACKUP_TABLE_SPECS.map((s) => [s.table, s]),
);

/** 取主键：备份行里 id / key / *Id 里第一个存在的（各表主键名不统一） */
function idOf(row: Record<string, unknown>): Record<string, unknown> {
  // RolePermission 的主键是复合键（roleId + permissionId），Prisma 生成的复合唯一键名是 roleId_permissionId。
  // 不特殊处理的话会退化成 { roleId } —— 那一列不唯一，upsert 会直接报「唯一约束不满足」。
  if (row.roleId !== undefined && row.permissionId !== undefined) {
    return { roleId_permissionId: { roleId: row.roleId, permissionId: row.permissionId } };
  }
  const id = row.id ?? row.key ?? Object.entries(row).find(([k]) => k.endsWith('Id'))?.[1];
  if (id === undefined) throw new Error('NO_PRIMARY_KEY');
  const field = row.id !== undefined ? 'id' : row.key !== undefined ? 'key'
    : Object.keys(row).find((k) => k.endsWith('Id')) as string;
  return { [field]: id };
}

/**
 * 这张表在本租户范围内的过滤条件。
 *
 * 返回 null = 这张表没有租户维度（部署级表），全量取。
 */
function scopeWhere(
  spec: BackupTableSpec,
  tenantId: string,
  parentIds: Record<string, string[]>,
): Record<string, unknown> | null {
  switch (spec.scope) {
    case 'self':
      return { id: tenantId };
    case 'own':
      return { tenantId };
    case 'member':
      // 用户靠成员关系圈定（一个人可能同时属于多个租户）
      return { memberships: { some: { tenantId } } };
    case 'child':
      // 父行 id 集合圈定：父表为空 → 这批子行一条都不该存在
      return { [spec.fk as string]: { in: parentIds[spec.parent as string] ?? [] } };
    case 'global':
      return null;
  }
}

/** 备份/恢复要访问的表操作集合（Prisma 模型名动态索引） */
type RestoreTable = {
  findMany: (a?: unknown) => Promise<unknown[]>;
  deleteMany: (a?: unknown) => Promise<unknown>;
  upsert: (a?: unknown) => Promise<unknown>;
  create: (a?: unknown) => Promise<unknown>;
};

/**
 * 恢复失败的逐表明细。
 *
 * 为什么原来不报：清空与写入都用空 catch 吞掉异常，
 * 结果是「恢复了一部分」在响应里看起来和「完全成功」一模一样 ——
 * 运维只能靠事后查库才知道少了数据，而那时已经晚了。
 */
export interface RestoreFailure {
  /** 表名（Prisma 模型名） */
  table: string;
  /** 该表没能恢复进来的行数 */
  failed: number;
  /** 首个错误原因（截断后可直接读懂） */
  reason: string;
  /** 清空阶段是否失败（被外键挡住 → 该表退化为部分合并） */
  clearFailed?: boolean;
}

/** 错误信息转成人能读懂的短文本（Prisma 原始报错带整条 SQL，太长） */
function errorMessage(e: unknown): string {
  const raw = e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message
    : String(e);
  return raw.replace(/\s+/g, ' ').slice(0, 200);
}

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('admin')
export class BackupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly media: MediaService,
  ) {}

  /**
   * 子表圈定范围要用的父行 id 集合。
   *
   * 必须在清空之前取：父表清空后 id 集合就空了，子表的清空范围会跟着失效
   * （子表一条都删不掉，恢复退化成「只写不清」）。
   */
  private async parentIdSets(tenantId: string): Promise<Record<string, string[]>> {
    const db = this.prisma as unknown as Record<string, { findMany: (a?: unknown) => Promise<unknown[]> }>;
    const out: Record<string, string[]> = {};
    for (const spec of BACKUP_TABLE_SPECS) {
      if (spec.scope !== 'child' || !spec.parent) continue;
      if (out[spec.parent]) continue;
      const rows = await db[spec.parent].findMany({ where: { tenantId }, select: { id: true } });
      out[spec.parent] = rows
        .map((r) => String((r as { id?: unknown }).id ?? ''))
        .filter((id) => id.length > 0);
    }
    return out;
  }

  /**
   * 允许写入的用户 id：现有成员 + 备份里带的本租户成员。
   *
   * 为什么用户要单独算：User 是全局账号、自己没有 tenantId 列，
   * 「属于本租户」的判据是成员关系 —— 而备份可以顺带把新成员带进来，
   * 所以还要把备份里 tenantId 命中本租户的成员关系中的 userId 算进来。
   */
  private async memberUserIds(tenantId: string, tables: Record<string, unknown>): Promise<Set<string>> {
    const db = this.prisma as unknown as Record<string, { findMany: (a?: unknown) => Promise<unknown[]> }>;
    const rows = await db.user.findMany({ where: { memberships: { some: { tenantId } } }, select: { id: true } });
    const ids = new Set(
      rows.map((r) => String((r as { id?: unknown }).id ?? '')).filter((id) => id.length > 0),
    );
    const memberships = Array.isArray(tables.membership) ? (tables.membership as Record<string, unknown>[]) : [];
    for (const m of memberships) {
      if (m.tenantId === tenantId && typeof m.userId === 'string') ids.add(m.userId);
    }
    return ids;
  }

  /**
   * 导出本租户的 JSON 快照。
   *
   * 每张表都按 BACKUP_TABLE_SPECS 声明的租户范围过滤 ——
   * 导出的是「本租户的数据」，不是整库（租户管理员不该能下载到别的租户的客户手机号）。
   */
  @RequirePermissions('platform:billing:manage')
  @Get('backup')
  async backup(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Res() res: Response): Promise<void> {
    const tenantId = user.activeTenantId as string;
    const db = this.prisma as unknown as Record<string, { findMany: (a?: unknown) => Promise<unknown[]> }>;
    const tables: Record<string, unknown> = {};
    const out: { exportedAt: string; version: number; scope: string; tenantId: string; tables: Record<string, unknown> } = {
      exportedAt: new Date().toISOString(),
      // version=2：内容口径变了（从整库改为本租户），消费方据此判断这份快照覆盖哪些数据
      version: 2,
      scope: 'tenant',
      tenantId,
      tables,
    };
    // 子表要靠父行的 id 圈定范围，所以父表必须先导出来（清单本身就是父表在前）
    const parentIds: Record<string, string[]> = {};
    for (const spec of BACKUP_TABLE_SPECS) {
      const where = scopeWhere(spec, tenantId, parentIds);
      let rows: unknown[];
      if (where === null) {
        rows = await db[spec.table].findMany();
      } else if (spec.scope === 'child' && (parentIds[spec.parent as string] ?? []).length === 0) {
        // 父表为空 → 这批子行一条都不该存在，直接记空数组
        rows = [];
      } else {
        rows = await db[spec.table].findMany({ where });
      }
      tables[spec.table] = rows;
      if (spec.scope === 'own' || spec.scope === 'self') {
        parentIds[spec.table] = rows
          .map((r) => String((r as { id?: unknown }).id ?? ''))
          .filter((id) => id.length > 0);
      }
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const json = JSON.stringify(out);
    // 同时在 uploads/backups 留一份，防下载中断。
    // 必须同时裁掉超出份数的旧备份：全库快照单份就有二十多 MB，
    // 之前只写不删，反复导出几次就能把宿主磁盘吃掉几百 MB，
    // 而且这些文件还会被 Docker 构建上下文带进镜像。
    try {
      const dir = join(this.config.get<string>('UPLOAD_DIR', 'uploads'), 'backups');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `backup-${stamp}.json`), json);
      await this.pruneBackups(dir, 3);
    } catch {
      // 留盘失败不阻塞下载
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${stamp}.json"`);
    res.send(json);
  }

  /**
   * 备份留盘只保留最近 keep 份，超出的按修改时间从旧到新删。
   * 单独抽出来是因为它失败绝不能影响备份本身（catch 已经吞掉），
   * 而且按修改时间排比按文件名排更稳：文件名里的时间戳来自 ISO 字符串，
   * 一旦有人改系统时区或时钟，文件名顺序就不再代表先后。
   */
  private async pruneBackups(dir: string, keep: number): Promise<void> {
    const names = (await readdir(dir)).filter((n) => n.startsWith('backup-') && n.endsWith('.json'));
    if (names.length <= keep) return;
    const withTime = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })),
    );
    withTime.sort((a, b) => a.mtime - b.mtime);
    for (const old of withTime.slice(0, withTime.length - keep)) {
      await unlink(join(dir, old.name)).catch(() => undefined);
    }
  }

  /**
   * 从备份 JSON 恢复（开源自部署必须有，否则「备份」只是个安慰）。
   *
   * 两种模式：
   * - merge（默认）：按主键 upsert，**不删**目标库多出来的行。误传一份旧备份不会清空现库。
   * - replace：先清空目标表再写入，才是真正的「回到某个时间点」。
   *
   * **两种模式都按租户隔离**：
   * - 清空只删**本租户**的行（deleteMany 带 where），不是整库；
   * - 写入前逐行验归属：不属于本租户的行一律拒写并计入失败 ——
   *   merge 模式不删行、只 upsert，跨租户写同样成立（上传的 JSON 是不可信输入）。
   *
   * 破坏性操作，所以：权限要最高、必须带 confirmToken、必须写审计。
   *
   * replace 模式包在**一个事务**里：原来是「清空一张表 → 写一行」逐条独立提交，
   * 中途失败会留下「表已清空、数据没回来」的半截状态 —— 比整体失败更难收拾，
   * 而且运维看不出丢了多少数据。现在要么整批生效，要么整批回滚。
   *
   * replace 模式分两个阶段：
   * - 阶段一清空（子表先于父表，否则外键挡着删不掉）
   * - 阶段二写回（父表先于子表，否则子行插不进去）
   * 原来是一张表「清空 + 写回」连着做，清空父表会把刚写好的子行级联删掉
   * （成员关系、跟进记录这些就是这么丢的）。
   */
  @RequirePermissions('platform:billing:manage')
  @Post('backup/restore')
  async restore(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body() body: { tables?: Record<string, unknown>; mode?: 'merge' | 'replace'; confirmToken?: string },
  ): Promise<{ mode: string; restored: Record<string, number>; failed: RestoreFailure[] }> {
    if (body?.confirmToken !== 'RESTORE') {
      throw new BadRequestException('RESTORE_CONFIRM_REQUIRED');
    }
    const tenantId = user.activeTenantId as string;
    const tables = body?.tables ?? {};
    if (typeof tables !== 'object' || Object.keys(tables).length === 0) {
      throw new BadRequestException('BACKUP_EMPTY');
    }
    // 只接受清单内的表名：上传的 JSON 是用户提供的，不能让它决定往哪张表写
    const picked = BACKUP_TABLES.filter((t) => Array.isArray(tables[t]));
    if (picked.length === 0) throw new BadRequestException('BACKUP_NO_KNOWN_TABLE');
    const mode = body?.mode === 'replace' ? 'replace' : 'merge';

    const restored: Record<string, number> = {};
    // 失败明细按表聚合：逐行记会把响应体撑爆（一张表几十条错误就没法看了）
    const failures = new Map<string, { failed: number; reason: string; clearReason: string }>();
    const noteFailure = (table: string, reason: string, isClear: boolean): void => {
      const cur = failures.get(table) ?? { failed: 0, reason: '', clearReason: '' };
      if (isClear) {
        if (!cur.clearReason) cur.clearReason = reason;
      } else {
        cur.failed += 1;
        if (!cur.reason) cur.reason = reason;
      }
      failures.set(table, cur);
    };

    // 圈定范围要用到的父行 id 集合：必须在清空之前取（清完父表就空了）
    const parentIds = await this.parentIdSets(tenantId);
    // 允许写入的用户：现有成员 + 备份里带的本租户成员（备份可以把新成员带进来）
    const memberIds = await this.memberUserIds(tenantId, tables);
    const belongs = (spec: BackupTableSpec, row: Record<string, unknown>): boolean => {
      switch (spec.scope) {
        case 'self':
          return String(row.id) === tenantId;
        case 'own':
          return String(row.tenantId) === tenantId;
        case 'member':
          return memberIds.has(String(row.id));
        case 'child':
          return (parentIds[spec.parent as string] ?? []).includes(String(row[spec.fk as string]));
        case 'global':
          return true;
      }
    };

    if (mode === 'replace') {
      // timeout 要显式给足：Prisma 默认 5s，对 30+ 张表的恢复远远不够（会被中途掐断）
      await this.prisma.$transaction(
        async (tx) => {
          const db = tx as unknown as Record<string, RestoreTable>;
          const raw = tx as unknown as { $executeRawUnsafe: (q: string) => Promise<unknown> };

          // —— 阶段一：清空本租户的行（子表先于父表，顺序与既有实现保持一致）——
          const ordered = [...picked].reverse();
          for (let ti = 0; ti < ordered.length; ti += 1) {
            const table = ordered[ti];
            const spec = BACKUP_SPEC_BY_TABLE[table];
            // 不清空的表：部署级表（不是任何租户的数据）与身份骨架表（user/tenant，
            // 删它们会级联清掉别的租户的成员关系或本租户的额度流水）
            if (!spec.clear) continue;
            const where = scopeWhere(spec, tenantId, parentIds);
            if (where === null) continue;
            // 父表为空 → 这批子行一条都不该存在，清空是空操作（不必发语句）
            if (spec.scope === 'child' && (parentIds[spec.parent as string] ?? []).length === 0) continue;
            // 每张表一个 SAVEPOINT：PostgreSQL 里一条语句失败会让**整个事务**进入
            // aborted 状态，之后所有语句都直接报错（哪怕语句本身没问题）。
            // 不逐段回滚到 SAVEPOINT，一行坏数据就能毁掉整次恢复。
            const spTable = `sp_tbl_${ti}`;
            await raw.$executeRawUnsafe(`SAVEPOINT ${spTable}`);
            try {
              await db[table].deleteMany({ where });
            } catch (e) {
              // 有外键约束时可能删不掉（被别的表引用）：只回滚这一张表的清空动作，
              // 事务不受影响、后面的表照常恢复（退化为部分合并，而不是整体失败）
              await raw.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${spTable}`);
              noteFailure(table, errorMessage(e), true);
            }
            await raw.$executeRawUnsafe(`RELEASE SAVEPOINT ${spTable}`);
          }

          // —— 阶段二：写回备份里的行（父表先于子表，清单顺序本身就是父表在前）——
          for (let ti = 0; ti < picked.length; ti += 1) {
            const table = picked[ti];
            const spec = BACKUP_SPEC_BY_TABLE[table];
            // permission 是静态动作目录，不从上传文件写回（否则等于允许注入新动作）
            if (spec.write === 'skip') continue;
            const rows = tables[table] as Record<string, unknown>[];
            let n = 0;
            for (let ri = 0; ri < rows.length; ri += 1) {
              const row = rows[ri];
              // 逐行一个 SAVEPOINT：单行失败（字段不兼容/约束冲突）只废掉这一行
              const spRow = `sp_row_${ti}_${ri}`;
              await raw.$executeRawUnsafe(`SAVEPOINT ${spRow}`);
              try {
                if (!belongs(spec, row)) {
                  throw new Error('ROW_NOT_IN_TENANT');
                }
                if (spec.write === 'upsert') {
                  // 不清空的表（租户行/用户/部署级配置）按主键更新，不留重复行
                  await db[table].upsert({
                    where: idOf(row),
                    create: row as never,
                    update: row as never,
                  });
                } else {
                  await db[table].create({ data: row as never });
                }
                await raw.$executeRawUnsafe(`RELEASE SAVEPOINT ${spRow}`);
                n += 1;
              } catch (e) {
                await raw.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${spRow}`);
                await raw.$executeRawUnsafe(`RELEASE SAVEPOINT ${spRow}`);
                // 原来这里是空 catch：失败被彻底吞掉，响应里「恢复成功」和
                // 「一半数据没回来」长得一模一样。现在记下来逐表上报。
                noteFailure(table, errorMessage(e), false);
              }
            }
            restored[table] = n;
          }
        },
        { timeout: 120000, maxWait: 20000 },
      );
    } else {
      // merge 模式不包事务：每条语句各自独立提交，一行失败天然不会影响其它行
      const db = this.prisma as unknown as Record<string, RestoreTable>;
      for (const table of [...picked].reverse()) {
        const spec = BACKUP_SPEC_BY_TABLE[table];
        if (spec.write === 'skip') continue;
        const rows = tables[table] as Record<string, unknown>[];
        let n = 0;
        for (const row of rows) {
          try {
            // 不是本租户的行拒写：合并模式虽然不删行，但 upsert 一样能写进别的租户
            if (!belongs(spec, row)) throw new Error('ROW_NOT_IN_TENANT');
            const where = idOf(row);
            await db[table].upsert({ where, create: row as never, update: row as never });
            n += 1;
          } catch (e) {
            noteFailure(table, errorMessage(e), false);
          }
        }
        restored[table] = n;
      }
    }

    const failed: RestoreFailure[] = [];
    for (const [table, f] of failures) {
      failed.push({
        table,
        failed: f.failed,
        reason: f.reason || f.clearReason || '未知原因',
        ...(f.clearReason ? { clearFailed: true } : {}),
      });
    }

    // 审计不在这里手写：audit.interceptor 会统一记，且它带 requestId / actorKind /
    // payloadDigest —— 手写那条既重复又缺这些字段，还会让「审计带 requestId」这条
    // 断言因为一行空值而失败。恢复是 POST 破坏性操作，拦截器本来就覆盖。
    return { mode, restored, failed };
  }

  /**
   * 产物占用统计。
   *
   * 口径从「MediaAsset 表记账之和」改成「**卷内真实占用**」：
   * 交付包（plan-packages）与全库备份（backups）是纯文件、不入库，
   * 孤儿文件（有文件、无 MediaAsset 行）连表都没有 ——
   * 只统计入库行会把真实占用严重低估（实测报表 4.2MB，卷内实际 314MB），
   * 面板说「才用了 4MB」，卷其实早被写满了。
   *
   * 字段保持向后兼容：usedBytes / quotaBytes / assets / oldest 名字不变，
   * 只是 usedBytes 换成真实占用；原来那个记账口径保留在 trackedBytes 里。
   */
  @RequirePermissions('platform:billing:manage')
  @Get('storage')
  async storage(@CurrentUser() user: AuthProfile & { activeTenantId?: string }): Promise<{
    usedBytes: number; quotaBytes: number; assets: number; oldest: string | null;
    trackedBytes: number; onDiskMediaBytes: number; orphanBytes: number;
    planPackageBytes: number; narrationAudioBytes: number; backupBytes: number; files: number;
    tenantUsedBytes: number;
  }> {
    const agg = await this.prisma.mediaAsset.aggregate({ _sum: { sizeBytes: true }, _count: true, _min: { createdAt: true } });
    // 配额换算与上传闸门同一份来源（media.quotaBytes），避免「面板说还有空间、上传却被拒」
    const quotaBytes = this.media.quotaBytes();
    const usage = await this.media.volumeUsage();
    return {
      // usedBytes = 卷内真实占用（含交付包与全库备份，回答「磁盘会不会满」）
      usedBytes: usage.usedBytes,
      // tenantUsedBytes = 本租户已用产物字节，与上传闸门同一个函数算出来的（回答「我还能传多少」）
      // 两个口径不同是有意的：配额按租户算，磁盘占用是全局的；混用会得出「还有空间却传不上去」
      tenantUsedBytes: await this.media.tenantUsedBytes(user.activeTenantId as string),
      quotaBytes,
      assets: agg._count,
      oldest: agg._min.createdAt?.toISOString() ?? null,
      trackedBytes: usage.trackedBytes,
      onDiskMediaBytes: usage.onDiskMediaBytes,
      orphanBytes: usage.orphanBytes,
      planPackageBytes: usage.planPackageBytes,
      narrationAudioBytes: usage.narrationAudioBytes,
      backupBytes: usage.backupBytes,
      files: usage.files,
    };
  }

  /**
   * 清理 beforeDays 天前、且未被任何地方引用的产物（DB 行 + 本地文件）。
   *
   * 引用集合来自 MediaService.referencedAssetIds()（唯一真源）：
   * 少收一个字段 = 删掉仍在用的图 —— 方案户型图裂了、交付包缺图、头像变空白。
   */
  @RequirePermissions('platform:billing:manage')
  @Post('storage/cleanup')
  async cleanup(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Query('beforeDays') beforeDaysRaw?: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    const tenantId = user.activeTenantId as string;
    const beforeDays = Math.max(0, Number(beforeDaysRaw ?? 30) || 30);
    const cutoff = new Date(Date.now() - beforeDays * 86_400_000);
    const candidates = await this.prisma.mediaAsset.findMany({
      // 必须按租户过滤：以前这里只按时间筛，租户管理员点一次「清理」
      // 会把**别的租户**的产物行与文件一起删掉（跨租户数据删除）。
      // 与备份/恢复同一口径：本租户。
      where: { createdAt: { lt: cutoff }, tenantId },
      select: { id: true, filePath: true, sizeBytes: true },
    });
    // 引用集合在这里查、规则只有一处定义（MediaService.collectReferencedAssetIds）：
    // 方案户型图/附加户型图/渲染图/视频、布局点位图、产品主图、灯光场景源图与视频、用户头像
    const referenced = await this.media.referencedAssetIds();

    let deleted = 0;
    let freedBytes = 0;
    for (const c of candidates) {
      if (referenced.has(c.id)) continue;
      try {
        await stat(this.media.resolveSafe(c.filePath));
        await unlink(this.media.resolveSafe(c.filePath));
      } catch {
        // 文件已不存在，照常删行
      }
      await this.prisma.mediaAsset.delete({ where: { id: c.id } });
      deleted += 1;
      freedBytes += c.sizeBytes;
    }
    return { deleted, freedBytes };
  }
}
