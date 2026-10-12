import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { MediaService } from '../media/media.service.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { PlansService } from './plans.service.js';
import {
  attachFloorplanSchema,
  createPlanSchema,
  updatePlanPageSchema,
  type AttachFloorplanDto,
  type CreatePlanDto,
  type UpdatePlanPageDto,
} from './plans.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('plans')
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly media: MediaService,
  ) {}

  @RequirePermissions('content:generate')
  @Post()
  create(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createPlanSchema)) dto: CreatePlanDto,
  ) {
    return this.plans.create({
      tenantId: user.activeTenantId as string,
      userId: user.id,
      title: dto.title,
      customer: dto.customer ?? '',
      area: dto.area ?? '',
      budget: dto.budget ?? '',
      ecosystem: dto.ecosystem ?? '',
      store: dto.store ?? '',
      highlights: dto.highlights ?? '',
      keySpaces: dto.keySpaces ?? '',
      needs: dto.needs ?? '',
      style: dto.style,
      edition: dto.edition,
      pageCount: dto.pageCount,
      floorplanAssetId: dto.floorplanAssetId,
      layoutPoints: dto.layoutPoints,
    });
  }

  @RequirePermissions('content:generate')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.plans.list(user.activeTenantId as string);
  }

  @RequirePermissions('content:generate')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.plans.detail(user.activeTenantId as string, id);
  }

  /** 挂接户型图+点位（点位编辑器 → 方案空间动线页） */
  @RequirePermissions('content:generate')
  @Patch(':id/floorplan')
  attachFloorplan(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(attachFloorplanSchema)) dto: AttachFloorplanDto,
  ) {
    return this.plans.attachFloorplan(user.activeTenantId as string, id, { floorplanAssetId: dto.floorplanAssetId, layoutPoints: dto.layoutPoints });
  }

  /** AI 渲染精装修效果图（基于已挂接的客户户型平面图） */
  @RequirePermissions('content:generate')
  @Post(':id/render-floorplan')
  renderFloorplan(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.plans.renderFloorplan(user.activeTenantId as string, user.id, id);
  }

  @RequirePermissions('content:generate')
  @Patch(':id/pages/:index')
  updatePage(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Param('index') index: string,
    @Body(new ZodValidationPipe(updatePlanPageSchema)) dto: UpdatePlanPageDto,
  ) {
    return this.plans.updatePage(user.activeTenantId as string, id, { index: Number(index), heading: dto.heading, body: dto.body, narration: dto.narration });
  }

  @RequirePermissions('content:generate')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.plans.remove(user.activeTenantId as string, id);
  }
}

/** 客户分享只读端点：无鉴权（凭 shareToken 随机 uuid），微信内直接打开 */
@Controller('public/plans')
export class PublicPlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly media: MediaService,
  ) {}

  @Get(':token')
  view(@Param('token') token: string) {
    return this.plans.byShareToken(token);
  }

  /** 分享页户型底图文件流（凭 shareToken 免鉴权） */
  @Get(':token/floorplan')
  async floorplan(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const plan = await this.plans.byShareToken(token);
    const assetId = (plan as { floorplanAssetId?: string | null }).floorplanAssetId;
    if (!assetId) {
      res.status(404);
      res.end();
      return;
    }
    const asset = await this.media.byId(assetId);
    const buf = await readFile(this.media.resolveSafe(asset.filePath));
    res.setHeader('Content-Type', asset.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  }

  /** 分享页精装修效果图文件流（凭 shareToken 免鉴权；客户端 LayoutSlide 优先用此图） */
  @Get(':token/rendered-floorplan')
  async renderedFloorplan(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const plan = await this.plans.byShareToken(token);
    const assetId = (plan as { renderedFloorplanAssetId?: string | null }).renderedFloorplanAssetId;
    if (!assetId) {
      res.status(404);
      res.end();
      return;
    }
    const asset = await this.media.byId(assetId);
    const buf = await readFile(this.media.resolveSafe(asset.filePath));
    res.setHeader('Content-Type', asset.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  }
}
