import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
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
  'product', 'modelSetting', 'floorplanLayout', 'orderRequest', 'orderNote',
] as const;

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
    // 同时在 uploads/backups 留一份，防下载中断
    try {
      const dir = join(this.config.get<string>('UPLOAD_DIR', 'uploads'), 'backups');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `backup-${stamp}.json`), json);
    } catch {
      // 留盘失败不阻塞下载
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${stamp}.json"`);
    res.send(json);
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
    const [plans, layouts] = await Promise.all([
      this.prisma.planProject.findMany({ where: { floorplanAssetId: { not: null } }, select: { floorplanAssetId: true } }),
      this.prisma.floorplanLayout.findMany({ select: { mediaAssetId: true } }),
    ]);
    const referenced = new Set<string>([
      ...plans.map((p) => p.floorplanAssetId),
      ...layouts.map((l) => l.mediaAssetId),
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
