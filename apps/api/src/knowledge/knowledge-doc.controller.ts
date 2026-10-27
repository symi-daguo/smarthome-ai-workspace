import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { z } from 'zod';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { decodeUploadName } from '../common/upload-name.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { KnowledgeDocService } from './knowledge-doc.service.js';

const searchSchema = z.object({ query: z.string().min(1).max(500) });
const toggleSchema = z.object({ enabled: z.boolean() });

/**
 * 账号级本地资料库（`/api/knowledge/*`）。
 *
 * 与 `/api/knowledge/external/*` 分开是刻意的：
 * 外部引擎（WeKnora/Obsidian）要用户自己部署、召回更强但门槛高；
 * 本地资料库是**零配置兜底**——什么都不装，上传就生效。
 * 两条路互不干扰，前端合并成一个「资料库」入口，按可用性自动用哪条。
 *
 * 权限：管理资料 knowledge:manage；预览召回效果只需 knowledge:read
 * （用户得能确认"AI 到底查不查得到"，否则传了也不知道有没有用）。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('knowledge')
export class KnowledgeDocController {
  constructor(private readonly docs: KnowledgeDocService) {}

  // 读接口用读权限：以前这里要 knowledge:manage，
  // 于是「只能查资料库、不能改」的角色（finance）根本打不开资料库列表。
  @RequirePermissions('knowledge:read')
  @Get('docs')
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.docs.list(user.activeTenantId as string);
  }

  // 单文件 20MB 上限：超过就在 multer 层拒掉，不进内存更不进解析
  @RequirePermissions('knowledge:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @Post('docs/upload')
  async upload(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    // 没有文件时 multer 给的是 undefined，直接取 .buffer 会抛 TypeError 变成 500。
    // 客户端参数错误就该是 400，不然调用方分不清是自己传错还是服务端坏了。
    if (!file) throw new BadRequestException('请选择要上传的文件');
    return this.docs.upload(user.activeTenantId as string, {
      buffer: file.buffer,
      // multipart 的 filename 头被按 latin1 解读，要转回 UTF-8，否则标题变乱码
      originalName: decodeUploadName(file.originalname),
      mimeType: file.mimetype,
    });
  }

  @RequirePermissions('knowledge:manage')
  @Post('docs/:id/toggle')
  toggle(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(toggleSchema)) dto: { enabled: boolean },
  ) {
    return this.docs.toggle(user.activeTenantId as string, id, dto.enabled);
  }

  @RequirePermissions('knowledge:manage')
  @Delete('docs/:id')
  async remove(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ): Promise<void> {
    await this.docs.remove(user.activeTenantId as string, id);
  }

  /** 预览召回效果：上传完就能确认「AI 到底查不查得到我要的东西」 */
  @RequirePermissions('knowledge:read')
  @Post('docs/search')
  async search(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(searchSchema)) dto: { query: string },
  ) {
    return this.docs.search(user.activeTenantId as string, dto.query);
  }
}
