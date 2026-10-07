import { BadRequestException, Body, Controller, Get, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
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
  type GenerateImageDto,
  type GenerateVideoDto,
  type PurchaseMaterialDto,
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
      ratio: '16:9',
      title: dto.title,
    });
  }

  @RequirePermissions('content:generate')
  @Get('assets')
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.media.list(user.activeTenantId as string);
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
    const asset = await this.media.get(user.activeTenantId as string, id);
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
