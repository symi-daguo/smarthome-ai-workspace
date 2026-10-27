import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { AgentsService } from './agents.service.js';
import { createAgentSchema, updateAgentSchema, type CreateAgentDto, type UpdateAgentDto } from './agents.schemas.js';

/**
 * 定制智能体：租户内的人设/系统提示词 CRUD。
 * 权限按读写切分：看 content:read，建/改/删 content:generate，数据按租户隔离。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @RequirePermissions('content:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.agents.list(user.activeTenantId as string);
  }

  /** 建智能体：写操作（落 CustomAgent 行），要 content:generate（同模块 PATCH/DELETE 的口径） */
  @RequirePermissions('content:generate')
  @Post()
  create(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createAgentSchema)) dto: CreateAgentDto,
  ) {
    return this.agents.create(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('content:generate')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAgentSchema)) dto: UpdateAgentDto,
  ) {
    return this.agents.update(user.activeTenantId as string, id, dto);
  }

  @RequirePermissions('content:generate')
  @Delete(':id')
  remove(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.agents.remove(user.activeTenantId as string, id);
  }
}