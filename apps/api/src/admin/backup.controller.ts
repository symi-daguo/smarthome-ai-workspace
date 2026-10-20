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
  // 0.1.45 素材库投稿
  'materialSubmission',
  // 0.1.53 Agent 机器接入：机器账号与 API Key 丢了就得全部重新签发，快照丢了就再也回不到操作前
  'apiKey', 'changeSnapshot',
  // 0.1.75 本地资料库：漏了它，备份恢复后门店资料会凭空消失
  'knowledgeDoc',
  // 0.2.4 提交幂等记录：漏了它，恢复后重试窗口内的提交会被当成首次执行（可能重复扣费）
  'idempotencyRecord',
] as const;

/** 取主键：备份行里 id / key / *Id 里第一个存在的（各表主键名不统一） */
function idOf(row: Record<string, unknown>): Record<string, unknown> {
  const id = row.id ?? row.key ?? Object.entries(row).find(([k]) => k.endsWith('Id'))?.[1];
  if (id === undefined) throw new Error('NO_PRIMARY_KEY');
  const field = row.id !== undefined ? 'id' : row.key !== undefined ? 'key'
    : Object.keys(row).find((k) => k.endsWith('Id')) as string;
  return { [field]: id };
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
   * 从备份 JSON 恢复（参考站无此能力；开源自部署必须有，否则「备份」只是个安慰）。
   *
   * 两种模式：
   * - merge（默认）：按主键 upsert，**不删**目标库多出来的行。误传一份旧备份不会清空现库。
   * - replace：先清空目标表再写入，才是真正的「回到某个时间点」。
   *
   * 破坏性操作，所以：权限要最高、必须带 confirmToken、必须写审计。
   * 顺序按 BACKUP_TABLES 逆序 —— 有外键关联的表先清空、后写入，失败时留下的破坏面最小。
   */
  @RequirePermissions('platform:billing:manage')
  @Post('backup/restore')
  async restore(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body() body: { tables?: Record<string, unknown>; mode?: 'merge' | 'replace'; confirmToken?: string },
  ): Promise<{ mode: string; restored: Record<string, number> }> {
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
    const db = this.prisma as unknown as Record<string, {
      findMany: (a?: unknown) => Promise<unknown[]>;
      deleteMany: (a?: unknown) => Promise<unknown>;
      upsert: (a?: unknown) => Promise<unknown>;
      create: (a?: unknown) => Promise<unknown>;
    }>;

    const restored: Record<string, number> = {};
    // 逆序：先处理靠后的表
    for (const table of [...picked].reverse()) {
      const rows = tables[table] as Record<string, unknown>[];
      if (mode === 'replace') {
        try {
          await db[table].deleteMany({});
        } catch {
          // 有外键约束时可能删不掉（被别的表引用），此时退化为 merge 而不是整体失败
        }
      }
      let n = 0;
      for (const row of rows) {
        try {
          if (mode === 'replace') {
            await db[table].create({ data: row as never });
          } else {
            const where = idOf(row);
            await db[table].upsert({ where, create: row as never, update: row as never });
          }
          n += 1;
        } catch {
          // 单行失败（字段不兼容/约束冲突）跳过，不让一行坏数据毁掉整次恢复
        }
      }
      restored[table] = n;
    }

    // 审计不在这里手写：audit.interceptor 会统一记，且它带 requestId / actorKind /
    // payloadDigest —— 手写那条既重复又缺这些字段，还会让「审计带 requestId」这条
    // 断言因为一行空值而失败。恢复是 POST 破坏性操作，拦截器本来就覆盖。
    return { mode, restored };
  }

  @RequirePermissions('platform:billing:manage')
  @Get('storage')
  async storage(): Promise<{ usedBytes: number; quotaBytes: number; assets: number; oldest: string | null }> {
    const agg = await this.prisma.mediaAsset.aggregate({ _sum: { sizeBytes: true }, _count: true, _min: { createdAt: true } });
    const quotaMb = Number(process.env.UPLOAD_QUOTA_MB ?? 4096);
    return {
      usedBytes: agg._sum.sizeBytes ?? 0,
      quotaBytes: quotaMb * 1024 * 1024,
      assets: agg._count,
      oldest: agg._min.createdAt?.toISOString() ?? null,
    };
  }

  /** 清理 beforeDays 天前、且未被方案户型图/点位布局引用的产物（DB 行 + 本地文件） */
  @RequirePermissions('platform:billing:manage')
  @Post('storage/cleanup')
  async cleanup(@Query('beforeDays') beforeDaysRaw?: string): Promise<{ deleted: number; freedBytes: number }> {
    const beforeDays = Math.max(0, Number(beforeDaysRaw ?? 30) || 30);
    const cutoff = new Date(Date.now() - beforeDays * 86_400_000);
    const candidates = await this.prisma.mediaAsset.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, filePath: true, sizeBytes: true },
    });
    // 排除仍被引用的资产
    const [plans, layouts, products] = await Promise.all([
      this.prisma.planProject.findMany({ where: { floorplanAssetId: { not: null } }, select: { floorplanAssetId: true } }),
      this.prisma.floorplanLayout.findMany({ select: { mediaAssetId: true } }),
      // 产品主图（=点位图标）被引用时不得清理
      this.prisma.product.findMany({ where: { active: true, imageUrl: { not: '' } }, select: { imageUrl: true } }),
    ]);
    const referenced = new Set<string>([
      ...plans.map((p) => p.floorplanAssetId),
      ...layouts.map((l) => l.mediaAssetId),
      ...products.map((p) => p.imageUrl.match(/\/api\/media\/assets\/([^/]+)\/file/)?.[1]),
    ].filter((v): v is string => Boolean(v)));

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
