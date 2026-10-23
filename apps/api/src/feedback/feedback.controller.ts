import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { FeedbackService } from './feedback.service.js';
import {
  createFeedbackSchema,
  updateFeedbackSchema,
  type CreateFeedbackDto,
  type UpdateFeedbackDto,
} from './feedback.schemas.js';

/**
 * 问题反馈：租户内的问题/需求工单。
 * 提交与查看用 cs:manage（seed 里所有角色都有：遇到问题的人恰恰可能是权限最低的人，
 * 反馈入口不能因为角色低而关闭）；状态推进与回复用 platform:billing:manage（管理员）；
 * 删除仅提交者本人。数据按租户隔离。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @RequirePermissions('cs:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.feedback.list(user.activeTenantId as string);
  }

  @RequirePermissions('cs:read')
  @Post()
  create(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createFeedbackSchema)) dto: CreateFeedbackDto,
  ) {
    // userId 只取当前登录用户，不接受请求体传入
    return this.feedback.create(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('cs:read')
  @Get(':id')
  detail(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.feedback.detail(user.activeTenantId as string, id);
  }

  /**
   * 「提交到作者仓库」的 issue 预填链接。
   *
   * 单独一个端点而不是在详情里多带一个字段：链接是**一次性拼装**的
   * （含时间戳与截断后的摘要），放详情里会每次都白算一遍。
   */
  @RequirePermissions('cs:read')
  @Get(':id/issue-link')
  issueLink(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.feedback.issueLink(user.activeTenantId as string, id);
  }

  @RequirePermissions('cs:read')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
  ) {
    return this.feedback.remove(user.activeTenantId as string, id, user.id);
  }

  @RequirePermissions('platform:billing:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFeedbackSchema)) dto: UpdateFeedbackDto,
  ) {
    return this.feedback.update(user.activeTenantId as string, id, user.id, dto);
  }
}