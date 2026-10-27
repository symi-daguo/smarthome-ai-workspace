import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { LightingService, LightingDiagnosisService, DIAGNOSIS_MODES, DIAGNOSIS_BOUNDARY } from './lighting.service.js';
import { createSceneSchema, updateSceneSchema, diagnoseSchema, type CreateSceneDto, type UpdateSceneDto, type DiagnoseDto } from './lighting.schemas.js';

/**
 * 智能灯光场景：灯具编排 + 时间轴的 CRUD，出片后回填 videoAssetId。
 * 权限按读写切分：看 content:read，建/改/删 content:generate，数据按租户隔离。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('lighting')
export class LightingController {
  constructor(
    private readonly lighting: LightingService,
    private readonly diagnosis: LightingDiagnosisService,
  ) {}

  /** 问诊任务定义：前端据此渲染，避免前后端各写一份选项导致对不上 */
  @RequirePermissions('content:read')
  @Get('diagnose/modes')
  diagnosisModes() {
    return { modes: DIAGNOSIS_MODES, boundary: DIAGNOSIS_BOUNDARY };
  }

  /** 灯光问诊：结构化问答 → 分级建议 + 灯组表 + 场景表（会扣额度） */
  @RequirePermissions('content:generate')
  @Post('diagnose')
  diagnose(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(diagnoseSchema)) dto: DiagnoseDto,
  ) {
    return this.diagnosis.run(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('content:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.lighting.list(user.activeTenantId as string);
  }

  /** 建场景：写操作（落 LightingScene 行），要 content:generate */
  @RequirePermissions('content:generate')
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

  /** 改场景：写操作，要 content:generate（同模块 DELETE 的口径） */
  @RequirePermissions('content:generate')
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