import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
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
import { JwtQueryGuard } from '../common/jwt-query.guard.js';
import { MediaService } from '../media/media.service.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { NarrationAudioService } from './narration-audio.service.js';
import { PlanPackageService } from './plan-package.service.js';
import { PlanPreflightService } from './plan-preflight.service.js';
import { PlansService } from './plans.service.js';
import {
  attachAssetSchema,
  attachFloorplanSchema,
  bindVideosSchema,
  createPlanSchema,
  narrationAudioSchema,
  updatePlanPageSchema,
  updatePlanTemplatesSchema,
  type AttachAssetDto,
  type AttachFloorplanDto,
  type BindVideosDto,
  type CreatePlanDto,
  type NarrationAudioDto,
  type UpdatePlanPageDto,
  type UpdatePlanTemplatesDto,
} from './plans.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('plans')
export class PlansController {
  private readonly logger = new Logger(PlansController.name);

  constructor(
    private readonly plans: PlansService,
    private readonly media: MediaService,
    private readonly packages: PlanPackageService,
    private readonly preflight: PlanPreflightService,
    private readonly narrationAudio: NarrationAudioService,
  ) {}

  /**
   * 交付前预检：逐页报出内部待办语句。
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
      // 预算分配建议（万元，键为生态中文名）：门店在建议条上确认的金额
      budgetSplit: dto.budgetSplit ?? {},
      style: dto.style,
      edition: dto.edition,
      floorplanTemplate: dto.floorplanTemplate,
      markerTemplate: dto.markerTemplate,
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
      // 乐观锁版本号：漏了它就等于没做冲突检测（这个坑踩过一次）
      versionNo: dto.versionNo,
      heading: dto.heading,
      subtitle: dto.subtitle,
      body: dto.body,
      narration: dto.narration,
      bullets: dto.bullets,
      quote: dto.quote,
    });
  }

  /**
   * 改交付模版（户型图设计样式 / 产品放置样式）。
   *
   * 模版不改案页文字，但改客户看到的东西，所以照样 bump versionNo、
   * 让逐页校对结论失效 —— 打完包再改模版，旧链接必须失效。
   */
  @RequirePermissions('content:generate')
  @Patch(':id/templates')
  updateTemplates(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePlanTemplatesSchema)) dto: UpdatePlanTemplatesDto,
  ) {
    return this.plans.updateTemplates(user.activeTenantId as string, id, dto);
  }

  /** 逐页校对确认：把当前版本标记为已校对；之后任何一次改文案都会让它自动失效 */  @RequirePermissions('content:generate')
  @Post(':id/review')
  review(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.plans.review(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:generate')
  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ): Promise<void> {
    await this.plans.remove(user.activeTenantId as string, id);
    // 交付包是纯文件、不入库：方案删了，包必须一起删。
    // 原来没有任何人回收它 —— 每删一个方案就永久留下一个包（实测单个 3-20MB），
    // 几十个方案就能吃掉几百 MB，正是「无错误数据挤爆硬盘」的典型来源。
    // 清理失败不阻断（方案已删，包只是残留，还能由运维兜底回收）。
    await this.packages.removeByPlan(id);
    // 讲解音频同理：也是纯文件不入库，同样不能变成没人认领的孤儿。
    await this.narrationAudio.removeByPlan(id);
  }

  /**
   * 绑定场景视频（最多 2 条）。
   * 刻意不做「在方案页现场生视频」——模型是客户自备的，现场生要消耗额度且慢；
   * 门店用「AI 生视频」出好片后挂进来，分享页就能内联播放。
   */
  @RequirePermissions('content:generate')
  @Patch(':id/videos')
  bindVideos(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(bindVideosSchema)) dto: BindVideosDto,
  ) {
    return this.plans.bindVideos(user.activeTenantId as string, user.id, id, dto.videoAssetIds ?? []);
  }

  /**
   * 把工具产物挂到工程（方案）上。
   *
   * 百宝箱里的每个工具都产出素材，但此前只有建方案时才能带渲染图、
   * 视频也只有 bindVideos 一条专用路 —— 工具页出的东西挂不进已在做的工程，
   * 工具之间因此彼此不相通。这一个端点让所有工具产物都能挂到当前工程。
   */
  @RequirePermissions('content:generate')
  @Patch(':id/assets')
  attachAsset(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(attachAssetSchema)) dto: AttachAssetDto,
  ) {
    return this.plans.attachAsset(user.activeTenantId as string, id, {
      assetId: dto.assetId,
      slot: dto.slot,
      layoutPoints: dto.layoutPoints ?? null,
      room: dto.room ?? '',
    });
  }

  /**
   * 交付打包（`POST /package`）：默认三件套，配了语音服务时多带一份讲解音频。
   * 只收前端生成好的 PPTX 与讲稿：图片包由服务端从 media 取，不必再传一遍原图。
   *
   * 讲解音频是**第四件**：讲稿文本传上来后，服务端顺带调语音服务合成一份音频放进包里。
   * 没配语音服务（或合成失败）时**降级为三件套**并在响应里说明原因 ——
   * 语音是加分项，不该让「没有语音服务」的部署交不出方案。
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
    const tenantId = user.activeTenantId as string;
    const plan = await this.plans.detail(tenantId, id);
    let audio: { name: string; buffer: Buffer } | null = null;
    let audioReason = '';
    if (this.narrationAudio.configured()) {
      try {
        const info = await this.narrationAudio.ensure(id, plan.versionNo, narration ?? '', plan.title);
        const buf = await this.narrationAudio.read(id, plan.versionNo);
        if (buf && buf.length) audio = { name: info.fileName, buffer: buf };
        else audioReason = 'NARRATION_AUDIO_EMPTY';
      } catch (e) {
        audioReason = e instanceof Error ? e.message : String(e);
        this.logger.warn(`讲解音频合成失败，降级为三件套：${audioReason}`);
      }
    } else {
      audioReason = 'NARRATION_TTS_NOT_CONFIGURED';
    }
    const result = await this.packages.build({
      tenantId,
      planId: id,
      userId: user.id,
      pptx: pptx.buffer,
      narration: narration ?? '',
      audio,
    });
    return { ...result, audio: { included: Boolean(audio), reason: audio ? '' : audioReason } };
  }

  /**
   * 讲解音频状态（只读）。
   *
   * 给智能体用：它要知道「这个方案的讲解音频有没有、地址在哪、念了多久」，
   * 才能决定要不要推到有喇叭的设备上播。
   * 还没生成过不是错误 —— 返回 `available: false` 并说明原因。
   */
  @RequirePermissions('content:read')
  @Get(':id/narration-audio')
  async narrationAudioInfo(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    const plan = await this.plans.detail(user.activeTenantId as string, id);
    const info = await this.narrationAudio.find(id, plan.versionNo, plan.title);
    if (!info) {
      return {
        available: false,
        reason: this.narrationAudio.configured() ? 'NARRATION_AUDIO_NOT_GENERATED' : 'NARRATION_TTS_NOT_CONFIGURED',
        versionNo: plan.versionNo,
      };
    }
    return {
      available: true,
      versionNo: plan.versionNo,
      fileName: info.fileName,
      bytes: info.bytes,
      mimeType: info.mimeType,
      durationSec: info.durationSec,
      generatedAt: info.generatedAt,
      downloadUrl: `/api/plans/${id}/narration-audio/file`,
    };
  }

  /**
   * 按需生成讲解音频。
   *
   * 文本由调用方给（讲稿的唯一来源在前端，服务端不重建页序），
   * 生成后落盘，同一版本重复调用会直接复用已存的那份。
   */
  @RequirePermissions('content:generate')
  @Post(':id/narration-audio')
  async generateNarrationAudio(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(narrationAudioSchema)) dto: NarrationAudioDto,
  ) {
    const plan = await this.plans.detail(user.activeTenantId as string, id);
    const info = await this.narrationAudio.ensure(id, plan.versionNo, dto.text, plan.title);
    return {
      available: true,
      versionNo: plan.versionNo,
      fileName: info.fileName,
      bytes: info.bytes,
      mimeType: info.mimeType,
      durationSec: info.durationSec,
      generatedAt: info.generatedAt,
      downloadUrl: `/api/plans/${id}/narration-audio/file`,
    };
  }
}

/**
 * 讲解音频文件流独立控制器：`<audio>` / 下载链接无法携带 Authorization 头，
 * 走 JwtQueryGuard（`?token=` 查询参数认证），与素材文件流同一套做法。
 *
 * 单独一个控制器而不是挂在 PlansController 上：类级守卫是 `AuthGuard('jwt')`，
 * 方法级守卫是**追加**而不是替换 —— 同一个类上两个守卫会先跑无 query 兜底的
 * 那个，`?token=` 永远轮不到，直接 401。
 */
@UseGuards(JwtQueryGuard, TenantGuard, PermissionsGuard)
@Controller('plans')
export class PlanNarrationAudioFileController {
  constructor(
    private readonly plans: PlansService,
    private readonly narrationAudio: NarrationAudioService,
  ) {}

  @RequirePermissions('content:read')
  @Get(':id/narration-audio/file')
  async narrationAudioFile(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const plan = await this.plans.detail(user.activeTenantId as string, id);
    const buf = await this.narrationAudio.read(id, plan.versionNo);
    if (!buf) {
      res.status(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buf);
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

  /** 分享页场景视频文件流（凭 shareToken 免鉴权）。微信内直接 <video src> 播放 */
  @Get(':token/video/:index')
  async video(@Param('token') token: string, @Param('index') index: string, @Res() res: Response): Promise<void> {
    const plan = await this.plans.byShareToken(token);
    const ids = (plan as { videoAssetIds?: string[] }).videoAssetIds ?? [];
    const i = Number(index);
    const assetId = Number.isInteger(i) && i >= 0 ? ids[i] : undefined;
    if (!assetId) {
      res.status(404);
      res.end();
      return;
    }
    const asset = await this.media.byId(assetId);
    res.setHeader('Content-Type', asset.mimeType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    // 视频体积大且内容不变，给长缓存：微信里来回翻页不必重下
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', asset.sizeBytes || 0);
    if (!asset.sizeBytes) {
      res.status(404);
      res.end();
      return;
    }
    // 直接透传文件流：不整段读进内存，视频大了会顶爆容器内存
    const { createReadStream } = await import('node:fs');
    createReadStream(this.media.resolveSafe(asset.filePath)).pipe(res);
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
