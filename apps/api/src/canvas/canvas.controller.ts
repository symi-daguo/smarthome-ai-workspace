import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import {
  createConversationSchema,
  createTurnSchema,
  updateConversationSchema,
  updateTurnSchema,
  type CreateConversationDto,
  type CreateTurnDto,
  type UpdateConversationDto,
  type UpdateTurnDto,
} from './canvas.schemas.js';
import { CanvasService } from './canvas.service.js';

type TenantUser = AuthProfile & { activeTenantId?: string };

/**
 * AI 画布接口：对话线 CRUD、发起轮次、异步作业轮询、轮次编辑与删除。
 * 权限 content:generate（designer 及以上），数据按 activeTenantId 隔离。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('canvas')
export class CanvasController {
  constructor(private readonly canvas: CanvasService) {}

  @RequirePermissions('content:read')
  @Get('conversations')
  list(@CurrentUser() user: TenantUser) {
    return this.canvas.list(user.activeTenantId as string);
  }

  @RequirePermissions('content:read')
  @Post('conversations')
  create(@CurrentUser() user: TenantUser, @Body(new ZodValidationPipe(createConversationSchema)) dto: CreateConversationDto) {
    return this.canvas.create(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('content:read')
  @Get('conversations/:id')
  detail(@CurrentUser() user: TenantUser, @Param('id') id: string) {
    return this.canvas.detail(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:read')
  @Patch('conversations/:id')
  rename(@CurrentUser() user: TenantUser, @Param('id') id: string, @Body(new ZodValidationPipe(updateConversationSchema)) dto: UpdateConversationDto) {
    return this.canvas.rename(user.activeTenantId as string, id, dto);
  }

  @RequirePermissions('content:generate')
  @Delete('conversations/:id')
  remove(@CurrentUser() user: TenantUser, @Param('id') id: string) {
    return this.canvas.remove(user.activeTenantId as string, id);
  }

  /** 发起一轮：返回 { userTurnId, turnId, jobId }，出图在后台跑，前端轮询 /canvas/jobs/:id */
  @RequirePermissions('content:generate')
  @Post('conversations/:id/turns')
  createTurn(@CurrentUser() user: TenantUser, @Param('id') id: string, @Body(new ZodValidationPipe(createTurnSchema)) dto: CreateTurnDto) {
    return this.canvas.createTurn(user.activeTenantId as string, user.id, id, dto);
  }

  @RequirePermissions('content:generate')
  @Patch('turns/:id')
  updateTurn(@CurrentUser() user: TenantUser, @Param('id') id: string, @Body(new ZodValidationPipe(updateTurnSchema)) dto: UpdateTurnDto) {
    return this.canvas.updateTurn(user.activeTenantId as string, id, dto);
  }

  /** 删一轮连同其分支子树 */
  @RequirePermissions('content:generate')
  @Delete('turns/:id')
  removeTurn(@CurrentUser() user: TenantUser, @Param('id') id: string) {
    return this.canvas.removeTurn(user.activeTenantId as string, id);
  }

  @RequirePermissions('content:read')
  @Get('jobs/:id')
  job(@CurrentUser() user: TenantUser, @Param('id') id: string) {
    return this.canvas.job(user.activeTenantId as string, id);
  }

  /** 手动触发执行（正常流程由创建轮次时后台自动调用，此端点供补跑与排障） */
  @RequirePermissions('content:read')
  @Post('jobs/:id/run')
  runJob(@CurrentUser() user: TenantUser, @Param('id') id: string) {
    return this.canvas.runJob(user.activeTenantId as string, user.id, id);
  }

  /**
   * 任务中心列表：全租户的生成任务（不只 AI 画布）。
   * 任务球据此跨页面、跨刷新恢复红点，不再依赖前端内存态。
   */
  @RequirePermissions('content:read')
  @Get('tasks')
  listTasks(@CurrentUser() user: TenantUser) {
    return this.canvas.listTasks(user.activeTenantId as string);
  }

  /** 清空已结束任务（进行中的必须保留，否则用户会以为任务丢了） */
  @RequirePermissions('content:read')
  @Delete('tasks/finished')
  clearTasks(@CurrentUser() user: TenantUser) {
    return this.canvas.clearFinishedTasks(user.activeTenantId as string);
  }
}
