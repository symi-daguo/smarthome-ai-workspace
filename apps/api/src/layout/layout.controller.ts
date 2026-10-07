import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { LayoutService } from './layout.service.js';
import {
  createLayoutSchema,
  updateLayoutSchema,
  type CreateLayoutDto,
  type UpdateLayoutDto,
} from './layout.schemas.js';

@UseGuards(AuthGuard('jwt'), TenantGuard, PermissionsGuard)
@RequirePermissions('content:generate')
@Controller()
export class LayoutController {
  constructor(private readonly layout: LayoutService) {}

  /** 产品目录（点位图标数据源） */
  @Get('products')
  products() {
    return this.layout.products();
  }

  @Post('layouts')
  create(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Body(new ZodValidationPipe(createLayoutSchema)) dto: CreateLayoutDto,
  ) {
    return this.layout.create(user.activeTenantId as string, user.id, dto);
  }

  @Get('layouts')
  list(@CurrentUser() user: AuthProfile & { activeTenantId?: string }) {
    return this.layout.list(user.activeTenantId as string);
  }

  @Get('layouts/:id')
  detail(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.detail(user.activeTenantId as string, id);
  }

  @Get('layouts/:id/summary')
  summary(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.summary(user.activeTenantId as string, id);
  }

  @Patch('layouts/:id')
  update(
    @CurrentUser() user: AuthProfile & { activeTenantId?: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLayoutSchema)) dto: UpdateLayoutDto,
  ) {
    return this.layout.update(user.activeTenantId as string, id, dto);
  }

  @Delete('layouts/:id')
  remove(@CurrentUser() user: AuthProfile & { activeTenantId?: string }, @Param('id') id: string) {
    return this.layout.remove(user.activeTenantId as string, id);
  }
}
