import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { ContentService } from './content.service.js';
import {
  confirmExtractionSchema,
  transcriptExtractSchema,
  urlExtractSchema,
  type ConfirmExtractionDto,
  type TranscriptExtractDto,
  type UrlExtractDto,
} from './content.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@RequirePermissions('content:extract')
@Controller('content/extractions')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  // P1 上传资料：20MB 内存缓冲（本地单机形态，不落盘）
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @UploadedFile() file: Express.Multer.File,
    @Body('docType') rawDocType?: string,
  ) {
    this.content.assertFile(file);
    const docType = rawDocType === 'meeting' || rawDocType === 'generic' ? rawDocType : 'product';
    return this.content.run({
      tenantId: user.activeTenantId as string,
      userId: user.id,
      source: 'UPLOAD',
      sourceRef: file.originalname,
      docType,
      file,
    });
  }

  // P2 网页抓取
  @Post('url')
  fromUrl(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(urlExtractSchema)) dto: UrlExtractDto,
  ) {
    return this.content.run({
      tenantId: user.activeTenantId as string,
      userId: user.id,
      source: 'URL',
      sourceRef: dto.url,
      docType: dto.docType,
    });
  }

  // P3 对话纪要抽取（LLM 结构化，未配置 key 时降级规则）
  @Post('transcript')
  fromTranscript(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(transcriptExtractSchema)) dto: TranscriptExtractDto,
  ) {
    return this.content.run({
      tenantId: user.activeTenantId as string,
      userId: user.id,
      source: 'TRANSCRIPT',
      sourceRef: dto.title ?? '对话纪要',
      docType: dto.docType,
      text: dto.text,
    });
  }

  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.content.list(user.activeTenantId as string);
  }

  @Get('documents')
  documents(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.content.listDocuments(user.activeTenantId as string);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.content.detail(user.activeTenantId as string, id);
  }

  @Delete('documents/:id')
  removeDocument(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.content.removeDocument(user.activeTenantId as string, id);
  }

  @Post(':id/confirm')
  confirm(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(confirmExtractionSchema)) dto: ConfirmExtractionDto,
  ) {
    return this.content.confirm(user.activeTenantId as string, id, user.id, dto);
  }
}
