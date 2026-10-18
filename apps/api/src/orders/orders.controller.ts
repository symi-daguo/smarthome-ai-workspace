import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { OrdersService } from './orders.service.js';
import {
  addNoteSchema,
  createOrderSchema,
  followupSchema,
  intakeSchema,
  orderStatusSchema,
  updateOrderSchema,
  type AddNoteDto,
  type CreateOrderDto,
  type FollowupDto,
  type IntakeDto,
  type OrderStatusDto,
  type UpdateOrderDto,
} from './orders.schemas.js';

/**
 * 接单工作台：销售接待线索 CRUD + 状态机 + AI 协助（intake 解析 / 跟进建议）。
 * 权限 order:manage（tenant_admin / operator 具备），数据按租户隔离。
 */
@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermissions('order:read')
  @Get()
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.orders.list(user.activeTenantId as string);
  }

  @RequirePermissions('order:read')
  @Post('intake')
  intake(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Body(new ZodValidationPipe(intakeSchema)) dto: IntakeDto) {
    return this.orders.intake(user.activeTenantId as string, user.id, dto.rawInput, dto.clientRequestId);
  }

  @RequirePermissions('order:write')
  @Post()
  create(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Body(new ZodValidationPipe(createOrderSchema)) dto: CreateOrderDto) {
    return this.orders.create(user.activeTenantId as string, user.id, dto);
  }

  @RequirePermissions('order:write')
  @Get(':id')
  detail(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.orders.detail(user.activeTenantId as string, id);
  }

  @RequirePermissions('order:read')
  @Patch(':id')
  update(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string, @Body(new ZodValidationPipe(updateOrderSchema)) dto: UpdateOrderDto) {
    return this.orders.update(user.activeTenantId as string, id, dto);
  }

  @RequirePermissions('order:write')
  @Patch(':id/status')
  changeStatus(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string, @Body(new ZodValidationPipe(orderStatusSchema)) dto: OrderStatusDto) {
    return this.orders.changeStatus(user.activeTenantId as string, id, dto.status, { lostReason: dto.lostReason, planId: dto.planId });
  }

  @RequirePermissions('order:write')
  @Post(':id/notes')
  addNote(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string, @Body(new ZodValidationPipe(addNoteSchema)) dto: AddNoteDto) {
    return this.orders.addNote(user.activeTenantId as string, user.id, id, dto.content);
  }

  @RequirePermissions('order:write')
  @Post(':id/followup')
  followup(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(followupSchema)) dto: FollowupDto,
  ) {
    return this.orders.followupAdvice(user.activeTenantId as string, user.id, id, dto.clientRequestId);
  }

  @RequirePermissions('order:write')
  @Delete(':id')
  remove(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.orders.remove(user.activeTenantId as string, id);
  }
}
