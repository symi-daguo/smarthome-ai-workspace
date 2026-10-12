import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtQueryGuard } from '../common/jwt-query.guard.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { MediaService } from './media.service.js';
import {
  generateImageSchema,
  generateVideoSchema,
  purchaseMaterialSchema,
  renameAssetSchema,
  reverseImagePromptSchema,
  type GenerateImageDto,
  type GenerateVideoDto,
  type PurchaseMaterialDto,
  type RenameAssetDto,
  type ReverseImagePromptDto,
} from './media.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @RequirePermissions('content:generate')
  @Post('images')
  generateImage(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(generateImageSchema)) dto: GenerateImageDto,
  ) {
    return this.media.generateImage({
      tenantId: user.activeTenantId as string,
      userId: user.id,
      prompt: dto.prompt,
      size: dto.size,
      title: dto.title,
    });
  }

  /** 上传参考图反推提示词（视觉模型），返回详细描述供前端回填后文生图，保证成图风格一致 */
  @RequirePermissions('content:generate')
  @Post('images/reverse-prompt')
  reverseImagePrompt(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(reverseImagePromptSchema)) dto: ReverseImagePromptDto,
  ) {
    return this.media.reverseImagePrompt(user.activeTenantId as string, user.id, dto.assetId);
  }

  @RequirePermissions('content:generate')
  @Post('videos')
  generateVideo(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(generateVideoSchema)) dto: GenerateVideoDto,
  ) {
    return this.media.generateVideo({
      tenantId: user.activeTenantId as string,
      userId: user.id,
      prompt: dto.prompt,
      duration: String(dto.duration),
      resolution: dto.resolution.replace('P', ''),
      ratio: dto.ratio,
      firstFrameAssetId: dto.firstFrameAssetId,
      title: dto.title,
    });
  }

  @RequirePermissions('content:generate')
  @Get('assets')
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.media.list(user.activeTenantId as string);
  }

  /** 重命名我的资料（图片/视频）：最基本的修改能力；公共产品图不可改 */
  @RequirePermissions('content:generate')
  @Patch('assets/:id')
  renameAsset(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(renameAssetSchema)) dto: RenameAssetDto,
  ) {
    return this.media.renameAsset(user.activeTenantId as string, id, dto.title);
  }

  /** 删除我的资料（图片/视频）：DB 行 + 本地文件；公共产品图引用保护 */
  @RequirePermissions('content:generate')
  @Delete('assets/:id')
  deleteAsset(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.media.deleteAsset(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:generate')
  @Post('materials/purchase')
  purchase(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(purchaseMaterialSchema)) dto: PurchaseMaterialDto,
  ) {
    return this.media.purchaseMaterial(user.activeTenantId as string, user.id, dto.key);
  }

  /** 本地图片上传（户型平面图等）：落盘 uploads 卷 + 写 MediaAsset */
  @RequirePermissions('content:generate')
  @Post('uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @UploadedFile() file: Express.Multer.File,
    @Body('title') title?: string,
  ) {
    if (!file) throw new BadRequestException('EMPTY_FILE');
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) throw new BadRequestException('INVALID_IMAGE_TYPE');
    return this.media.uploadImage(user.activeTenantId as string, user.id, { buffer: file.buffer, mimeType: file.mimetype }, title ?? '');
  }
}

/**
 * 文件流独立控制器：img/video 标签无法携带 Authorization 头，
 * 走 JwtQueryGuard（?token= 查询参数认证），本地单机部署形态下可接受
 */
@UseGuards(JwtQueryGuard, TenantGuard, PermissionsGuard)
@Controller('media')
export class MediaFileController {
  constructor(private readonly media: MediaService) {}

  @RequirePermissions('content:generate')
  @Get('assets/:id/file')
  async file(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.media.resolveReadable(user.activeTenantId as string, id);
    const abs = this.media.resolveSafe(asset.filePath);
    const buf = await readFile(abs);
    res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const range = res.req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = Number(startStr);
      const end = endStr ? Math.min(Number(endStr), buf.length - 1) : buf.length - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
      res.setHeader('Content-Length', end - start + 1);
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  }
}
