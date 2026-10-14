import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AgentService } from './agent.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import {
  apiKeySchema, restoreSchema, serviceAccountSchema, snapshotSchema,
  type ApiKeyDto, type RestoreDto, type ServiceAccountDto, type SnapshotDto,
} from './agent.schemas.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthProfile } from '../auth/auth.service.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { COMMON_NOTES, MANIFEST, destructiveOps } from './manifest.js';

/**
 * Agent 机器接入端点（0.1.53）
 *
 * 权限口径：签发 Key / 建机器账号用 `tenant:member:manage`（租户管理员自带）。
 * 曾用 platform:tenant:manage，那是平台级权限、开源自部署的租户管理员根本没有，
 * 结果是「谁也发不出 Key」——权限定得太高，功能等于不存在。
 * Agent 日常操作走原有 RBAC，不受这里限制。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly prisma: PrismaService,
  ) {}

  private tenantOf(user: AuthProfile): string {
    if (!user.activeTenantId) throw new Error('TENANT_GUARD_MISSING');
    return user.activeTenantId;
  }

  /**
   * 能力清单。
   *   （默认）      → 索引：分组 + 危险操作清单，约 300 token，够 Agent 决定「我要进哪一组」
   *   ?group=quote  → 该组详细操作
   *   ?full=1       → 全量（114 条，约 3.4k token），只在通盘了解时用
   */
  @Get('manifest')
  manifest(@Query('group') group?: string, @Query('full') full?: string): unknown {
    if (full === '1') return { version: 1, notes: COMMON_NOTES, groups: MANIFEST };
    if (group) {
      const g = MANIFEST.find((x) => x.id === group);
      if (!g) {
        return { error: 'GROUP_NOT_FOUND', available: MANIFEST.map((x) => ({ id: x.id, name: x.name, ops: x.ops.length })) };
      }
      return { notes: COMMON_NOTES, group: g };
    }
    return {
      version: 1,
      notes: COMMON_NOTES,
      hint: '加 ?group=<id> 取单组详情；加 ?full=1 取全量。',
      groups: MANIFEST.map((g) => ({ id: g.id, name: g.name, about: g.about, ops: g.ops.length })),
      destructive: destructiveOps(),
    };
  }

  // ---------- 机器账号与 Key ----------

  @RequirePermissions('tenant:member:manage')
  @Post('service-accounts')
  createServiceAccount(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(serviceAccountSchema)) dto: ServiceAccountDto,
  ): Promise<unknown> {
    return this.agent.createServiceAccount(this.tenantOf(user), dto.name, dto.roleKey);
  }

  @RequirePermissions('tenant:member:manage')
  @Get('service-accounts')
  listServiceAccounts(@CurrentUser() user: AuthProfile): Promise<unknown> {
    return this.agent.listServiceAccounts(this.tenantOf(user));
  }

  @RequirePermissions('tenant:member:manage')
  @Post('keys')
  createKey(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(apiKeySchema)) dto: ApiKeyDto): Promise<unknown> {
    const userId = dto.serviceAccountId ?? user.id;
    return this.agent.createApiKey(this.tenantOf(user), userId, dto.name, dto.ttlDays);
  }

  @RequirePermissions('tenant:member:manage')
  @Get('keys')
  listKeys(@CurrentUser() user: AuthProfile): Promise<unknown> {
    return this.agent.listApiKeys(this.tenantOf(user));
  }

  @RequirePermissions('tenant:member:manage')
  @Post('keys/:id/revoke')
  revokeKey(@CurrentUser() user: AuthProfile, @Param('id') id: string): Promise<unknown> {
    return this.agent.revokeApiKey(this.tenantOf(user), id);
  }

  // ---------- 快照与还原 ----------

  @Post('snapshots')
  createSnapshot(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(snapshotSchema)) dto: SnapshotDto): Promise<unknown> {
    return this.agent.createSnapshot(this.tenantOf(user), user.id, dto.label, dto.trigger === 'auto' ? 'AUTO' : 'MANUAL');
  }

  @Get('snapshots')
  listSnapshots(@CurrentUser() user: AuthProfile, @Query('limit') limit?: string): Promise<unknown> {
    const n = Number(limit ?? 20);
    return this.agent.listSnapshots(this.tenantOf(user), Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20);
  }

  @Post('snapshots/:id/restore')
  restore(
    @CurrentUser() user: AuthProfile,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(restoreSchema)) dto: RestoreDto,
  ): Promise<unknown> {
    return this.agent.restoreSnapshot(this.tenantOf(user), id, dto.confirm, dto.dropNewer);
  }

  // ---------- 审计查询 ----------

  @RequirePermissions('platform:audit:view')
  @Get('audit')
  async audit(
    @CurrentUser() user: AuthProfile,
    @Query('requestId') requestId?: string,
    @Query('actorKind') actorKind?: 'AGENT' | 'USER' | 'SYSTEM',
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const n = Number(limit ?? 100);
    const take = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId: this.tenantOf(user),
        ...(requestId ? { requestId } : {}),
        ...(actorKind === 'AGENT' || actorKind === 'USER' || actorKind === 'SYSTEM' ? { actorKind } : {}),
      },
      select: {
        id: true, createdAt: true, actorId: true, actorKind: true, action: true, method: true,
        path: true, statusCode: true, ok: true, requestId: true, payloadDigest: true, durationMs: true, snapshotId: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return { count: rows.length, rows };
  }
}