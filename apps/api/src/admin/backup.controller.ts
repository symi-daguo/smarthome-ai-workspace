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
 *   - GET  /api/admin/backup        全库 JSON 快照下载（升级/迁移前留底；文件产物另在 uploads 卷）
 *   - GET  /api/admin/storage       产物占用统计（配额与已用）
 *   - POST /api/admin/storage/cleanup  删除 N 天前且未被方案/布局引用的产物（行+文件），防磁盘挤爆
 */
const BACKUP_TABLES = [
  'tenant', 'user', 'role', 'permission', 'rolePermission', 'membership',
  'tokenLedger', 'auditLog', 'extractionJob', 'extractedDocument', 'extractedField',
  'extractionDeficiency', 'reviewConfirmation', 'mediaAsset', 'planProject',
  'product', 'categoryDef', 'modelSetting', 'modelProfile', 'floorplanLayout', 'orderRequest', 'orderNote',
  // 0.1.40 起新增的表：漏掉任何一张都会让「全库备份」丢掉对应数据，恢复后凭空消失
  'customAgent', 'feedbackTicket', 'lightingScene',
  // 0.1.44 AI 画布：对话线/轮次/异步作业，缺任一张都会丢掉全部创作记录
  'imageConversation', 'imageTurn', 'generationJob',
  // 0.1.53 Agent 机器接入：机器账号与 API Key 丢了就得全部重新签发，快照丢了就再也回不到操作前
  'apiKey', 'changeSnapshot',
  // 0.1.75 本地资料库：漏了它，备份恢复后门店资料会凭空消失
  'knowledgeDoc',
  // 0.2.4 提交幂等记录：漏了它，恢复后重试窗口内的提交会被当成首次执行（可能重复扣费）
  'idempotencyRecord',
  // 对标账号情报：账号清单/采集到的内容/分析结论，缺任一张都会丢掉整条情报链路
  'benchmarkAccount', 'benchmarkContent', 'benchmarkInsight',
] as const;

/** 取主键：备份行里 id / key / *Id 里第一个存在的（各表主键名不统一） */
function idOf(row: Record<string, unknown>): Record<string, unknown> {
  const id = row.id ?? row.key ?? Object.entries(row).find(([k]) => k.endsWith('Id'))?.[1];
  if (id === undefined) throw new Error('NO_PRIMARY_KEY');
  const field = row.id !== undefined ? 'id' : row.key !== undefined ? 'key'
    : Object.keys(row).find((k) => k.endsWith('Id')) as string;
  return { [field]: id };
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

  @RequirePermissions('platform:billing:manage')
  @Get('backup')
  async backup(@Res() res: Response): Promise<void> {
    const db = this.prisma as unknown as Record<string, { findMany: (a?: unknown) => Promise<unknown[]> }>;
    const tables: Record<string, unknown> = {};
    const out: { exportedAt: string; version: number; tables: Record<string, unknown> } = { exportedAt: new Date().toISOString(), version: 1, tables };
    for (const table of BACKUP_TABLES) {
      tables[table] = await db[table].findMany();
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
   * 破坏性操作，所以：权限要最高、必须带 confirmToken、必须写审计。
   * 顺序按 BACKUP_TABLES 逆序 —— 有外键关联的表先清空、后写入，失败时留下的破坏面最小。
   *
   * replace 模式包在**一个事务**里：原来是「清空一张表 → 写一行」逐条独立提交，
   * 中途失败会留下「表已清空、数据没回来」的半截状态 —— 比整体失败更难收拾，
   * 而且运维看不出丢了多少数据。现在要么整批生效，要么整批回滚。
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

    if (mode === 'replace') {
      // timeout 要显式给足：Prisma 默认 5s，对 30+ 张表的恢复远远不够（会被中途掐断）
      await this.prisma.$transaction(
        async (tx) => {
          const db = tx as unknown as Record<string, RestoreTable>;
          const raw = tx as unknown as { $executeRawUnsafe: (q: string) => Promise<unknown> };
          // 逆序：先处理靠后的表（顺序与既有实现保持不变，不动）
          const ordered = [...picked].reverse();
          for (let ti = 0; ti < ordered.length; ti += 1) {
            const table = ordered[ti];
            const rows = tables[table] as Record<string, unknown>[];
            // 每张表一个 SAVEPOINT：PostgreSQL 里一条语句失败会让**整个事务**进入
            // aborted 状态，之后所有语句都直接报错（哪怕语句本身没问题）。
            // 不逐段回滚到 SAVEPOINT，一行坏数据就能毁掉整次恢复。
            const spTable = `sp_tbl_${ti}`;
            await raw.$executeRawUnsafe(`SAVEPOINT ${spTable}`);
            try {
              await db[table].deleteMany({});
            } catch (e) {
              // 有外键约束时可能删不掉（被别的表引用）：只回滚这一张表的清空动作，
              // 事务不受影响、后面的表照常恢复（退化为部分合并，而不是整体失败）
              await raw.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${spTable}`);
              noteFailure(table, errorMessage(e), true);
            }
            await raw.$executeRawUnsafe(`RELEASE SAVEPOINT ${spTable}`);

            let n = 0;
            for (let ri = 0; ri < rows.length; ri += 1) {
              // 逐行一个 SAVEPOINT：单行失败（字段不兼容/约束冲突）只废掉这一行
              const spRow = `sp_row_${ti}_${ri}`;
              await raw.$executeRawUnsafe(`SAVEPOINT ${spRow}`);
              try {
                await db[table].create({ data: rows[ri] as never });
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
        const rows = tables[table] as Record<string, unknown>[];
        let n = 0;
        for (const row of rows) {
          try {
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
  async cleanup(@Query('beforeDays') beforeDaysRaw?: string): Promise<{ deleted: number; freedBytes: number }> {
    const beforeDays = Math.max(0, Number(beforeDaysRaw ?? 30) || 30);
    const cutoff = new Date(Date.now() - beforeDays * 86_400_000);
    const candidates = await this.prisma.mediaAsset.findMany({
      where: { createdAt: { lt: cutoff } },
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
