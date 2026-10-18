import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { PlanPackageService } from './plan-package.service.js';
import { PlanPreflightService } from './plan-preflight.service.js';
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
    private readonly packages: PlanPackageService,
    private readonly preflight: PlanPreflightService,
  ) {}

  /**
   * 交付前预检（参考站 preflight-content）：逐页报出内部待办语句。
   * 只读、不改数据、不扣额度 —— 它是给人和 Agent 的「交付前体检」，
   * 真正的拦截门在 review（未校对不许打包）与 plan-package 服务里。
   */
  @RequirePermissions('content:read')
  @Get(':id/preflight')
  preflightCheck(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    const plan = this.plans.detail(user.activeTenantId as string, id);
    return plan.then((p) => this.preflight.inspect((p as { pages?: unknown }).pages));
  }

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
      // 「补充需求与服务资料」9 项
      priorityNeeds: dto.priorityNeeds ?? '',
      excludedItems: dto.excludedItems ?? '',
      renovationStage: dto.renovationStage ?? '',
      existingDevices: dto.existingDevices ?? '',
      serviceEvidence: dto.serviceEvidence ?? '',
      serviceScope: dto.serviceScope ?? '',
      serviceContact: dto.serviceContact ?? '',
      budgetItems: dto.budgetItems ?? '',
      budgetSource: dto.budgetSource ?? '',
      style: dto.style,
      edition: dto.edition,
      pageCount: dto.pageCount,
      floorplanAssetId: dto.floorplanAssetId,
      extraFloorplanAssetIds: dto.extraFloorplanAssetIds,
      floorplanFloors: dto.floorplanFloors,
      renderAssetIds: dto.renderAssetIds,
      renderAssetMeta: dto.renderAssetMeta,
      layoutPoints: dto.layoutPoints,
      clientRequestId: dto.clientRequestId,
    });
  }

  @RequirePermissions('content:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.plans.list(user.activeTenantId as string);
  }

  @RequirePermissions('content:read')
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
    return this.plans.attachFloorplan(user.activeTenantId as string, id, {
      floorplanAssetId: dto.floorplanAssetId,
      extraFloorplanAssetIds: dto.extraFloorplanAssetIds,
      floorplanFloors: dto.floorplanFloors,
      layoutPoints: dto.layoutPoints,
    });
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
    return this.plans.updatePage(user.activeTenantId as string, id, {
      index: Number(index),
      heading: dto.heading,
      subtitle: dto.subtitle,
      body: dto.body,
      narration: dto.narration,
      bullets: dto.bullets,
      quote: dto.quote,
    });
  }

  /** 逐页校对确认：把当前版本标记为已校对；之后任何一次改文案都会让它自动失效 */
  @RequirePermissions('content:generate')
  @Post(':id/review')
  review(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.plans.review(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:generate')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.plans.remove(user.activeTenantId as string, id);
  }

  /**
   * 交付三件套打包（参考站 `POST /package`）。
   * 只收前端生成好的 PPTX 与讲稿：图片包由服务端从 media 取，不必再传一遍原图。
   */
  @RequirePermissions('content:generate')
  @Post(':id/package')
  @UseInterceptors(FileInterceptor('pptx', { limits: { fileSize: 60 * 1024 * 1024 } }))
  async packagePlan(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @UploadedFile() pptx: Express.Multer.File | undefined,
    @Body('narration') narration?: string,
  ) {
    if (!pptx) throw new BadRequestException('PPTX_FILE_MISSING');
    return this.packages.build({
      tenantId: user.activeTenantId as string,
      planId: id,
      userId: user.id,
      pptx: pptx.buffer,
      narration: narration ?? '',
    });
  }
}

/**
 * 交付包文件流：**不走用户 JWT 守卫**。
 *
 * JwtQueryGuard 是给「用户自己的图片」用的，它背后的 JwtStrategy 要求 payload 带
 * 用户 sub/phone/tokenVersion 并查库 —— 交付包链接是自签的（sub=plan-package），
 * 套上去必然 401。
 *
 * 正确语义是 presigned URL：**链接本身就是凭证**，靠 JWT_SECRET 签名防伪
 * （拿不到 secret 就伪造不出来），2 小时过期，且方案一改版就失效。
 * 生成链接时已经校验过 content:read 权限，所以下载端不必重复。
 */
@Controller('plans')
export class PlanPackageController {
  constructor(private readonly packages: PlanPackageService) {}

  @Get('package/download')
  async download(@Query('token') token: unknown, @Res() res: Response): Promise<void> {
    // 声明成 unknown 是有意的：`?token=a&token=b` 时 Express 会给出数组。
    // 之前签名直链踩过这个坑 —— 前端用 fileUrl() 拼 URL，它会再追加一个登录 token，
    // 于是 token 变成数组、校验必然失败，报出来的是含糊的「签名无效」。
    // 这里显式区分「参数形状不对」和「签名不对」，便于排查。
    if (typeof token !== 'string' || !token) {
      res.status(404);
      res.end();
      return;
    }
    const found = await this.packages.resolve(token);
    const buf = await readFile(found.abs);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', found.contentDisposition);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buf);
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
