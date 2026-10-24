import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
  renameAssetSchema,
  reverseImagePromptSchema,
  type GenerateImageDto,
  type GenerateVideoDto,
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
      fitVideo: dto.fitVideo,
      background: dto.background,
      imageAssetId: dto.imageAssetId,
      maskDataUrl: dto.maskDataUrl,
      clientRequestId: dto.clientRequestId,
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
      clientRequestId: dto.clientRequestId,
      title: dto.title,
    });
  }

  @RequirePermissions('content:read')
  @Get('assets')
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.media.list(user.activeTenantId as string);
  }

  /** 重命名我的资料（图片/视频）：最基本的修改能力；公共产品图不可改 */
  @RequirePermissions('content:read')
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

  /**
   * 本地图片上传（户型平面图等）：落盘 uploads 卷 + 写 MediaAsset
   */
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

  /**
   * 视频素材上传：落盘 uploads 卷 + 写 MediaAsset（进「我的作品」）。
   *
   * 原先这个端点叫「素材库投稿上传」，配套的投稿审核/上架/购买交易已经去掉
   * （开源自用场景没有投稿数据来源），但**上传本身**要留着——
   * 用户自己拍的视频素材仍然要能进产物库。
   */
  @RequirePermissions('content:generate')
  @Post('materials/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  uploadMaterialVideo(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @UploadedFile() file: Express.Multer.File,
    @Body('title') title?: string,
  ) {
    if (!file) throw new BadRequestException('EMPTY_FILE');
    if (!/^video\//.test(file.mimetype)) throw new BadRequestException('INVALID_VIDEO_TYPE');
    return this.media.uploadVideo(user.activeTenantId as string, user.id, { buffer: file.buffer, mimeType: file.mimetype }, title ?? '');
  }
}

/**
 * 解析 Range 请求头（纯函数，便于单独验证）。
 *
 * 为什么不能直接按 '-' 硬拆字符串：bytes=100-（到末尾）与 bytes=-500（**最后** 500 字节）
 * 是两种不同语义，拆错就会给出错误的 Content-Range，浏览器据此判定「文件损坏」而拒绝播放。
 * 合法区间返回 {start,end}（闭区间），非法返回 null（调用方回 416）。
 */
export function parseByteRange(header: string, total: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  const startStr = m[1] ?? '';
  const endStr = m[2] ?? '';
  if (startStr === '' && endStr === '') return null;
  if (total <= 0) return null;
  if (startStr === '') {
    // 后缀区间：取文件末尾 N 字节
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, total - suffix);
    return { start, end: total - 1 };
  }
  const start = Number(startStr);
  if (!Number.isFinite(start) || start >= total) return null;
  const end = endStr === '' ? total - 1 : Math.min(Number(endStr), total - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/**
 * 文件流独立控制器：img/video 标签无法携带 Authorization 头，
 * 走 JwtQueryGuard（?token= 查询参数认证），本地单机部署形态下可接受
 */
@UseGuards(JwtQueryGuard, TenantGuard, PermissionsGuard)
@Controller('media')
export class MediaFileController {
  constructor(private readonly media: MediaService) {}

  @RequirePermissions('content:read')
  @Get('assets/:id/file')
  async file(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.media.resolveReadable(user.activeTenantId as string, id);
    const abs = this.media.resolveSafe(asset.filePath);
    // 流式发送而不是整文件读进内存：视频素材单文件上限 100MB，
    // 原实现 readFile 会把整个文件塞进 Node 堆，并发几个请求就可能把进程压垮。
    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      // 库里有行、磁盘上没文件（人工删过/卷没挂上）：按「文件不存在」回 404
      throw new NotFoundException('ASSET_FILE_MISSING');
    }
    res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const range = res.req.headers.range;
    if (range) {
      const parsed = parseByteRange(range, size);
      if (!parsed) {
        // 区间不合法：按 HTTP 语义回 416 并带上真实长度，客户端才知道该重新请求
        res.status(416);
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${size}`);
      res.setHeader('Content-Length', parsed.end - parsed.start + 1);
      // 只把请求的那一段读出去，不多读也不全读
      pipeFile(res, abs, { start: parsed.start, end: parsed.end });
      return;
    }
    res.setHeader('Content-Length', size);
    pipeFile(res, abs);
  }
}

/**
 * 把文件按流接到响应上。
 *
 * 为什么必须监听 'error'：Readable 没有 error 监听器时，出错会变成**未捕获异常**，
 * 直接把进程带走（文件在 stat 之后被删、客户端中途断开都会触发）。
 * 这里出错只毁掉这一次响应，不影响服务。
 */
function pipeFile(res: Response, abs: string, opts?: { start: number; end: number }): void {
  const stream = createReadStream(abs, opts);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
}
