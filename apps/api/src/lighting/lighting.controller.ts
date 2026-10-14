import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { LightingService } from './lighting.service.js';
import { createSceneSchema, updateSceneSchema, type CreateSceneDto, type UpdateSceneDto } from './lighting.schemas.js';

/**
 * 智能灯光场景：灯具编排 + 时间轴的 CRUD，出片后回填 videoAssetId。
 * 权限 content:generate（所有登录成员的基础能力），数据按租户隔离。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('lighting')
export class LightingController {
  constructor(private readonly lighting: LightingService) {}

  @RequirePermissions('content:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.lighting.list(user.activeTenantId as string);
  }

  @RequirePermissions('content:read')
  @Post()
  create(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createSceneSchema)) dto: CreateSceneDto,
  ) {
    return this.lighting.create(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('content:read')
  @Get(':id')
  detail(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.lighting.detail(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:read')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSceneSchema)) dto: UpdateSceneDto,
  ) {
    return this.lighting.update(user.activeTenantId as string, id, dto);
  }

  @RequirePermissions('content:generate')
  @Delete(':id')
  remove(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.lighting.remove(user.activeTenantId as string, id);
  }
}