import { Body, Controller, ForbiddenException, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthProfile } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PermissionsGuard } from '../rbac/permissions.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { TenantGuard } from './tenant.guard.js';
import { grantTokensSchema, updateTenantSchema, type GrantTokensDto, type UpdateTenantDto } from './tenants.schemas.js';
import { TenantsService } from './tenants.service.js';

@UseGuards(AuthGuard('jwt'), TenantGuard)
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('mine')
  mine(@CurrentUser() user: AuthProfile) {
    return this.tenants.mine(user);
  }

  @UseGuards(PermissionsGuard)
  @RequirePermissions('tenant:member:manage')
  @Patch('current')
  update(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(updateTenantSchema)) dto: UpdateTenantDto) {
    return this.tenants.update(user.activeTenantId as string, dto.name, dto.installRate);
  }

  @Get('current')
  async current(@CurrentUser() user: AuthProfile) {
    // 工作台设置（名称 + 安装调试费率）走租户表，不走登录时的 membership 快照 ——
    // 改了费率后不用重新登录就能读到新值。
    const settings = await this.tenants.settings(user.activeTenantId as string);
    return settings ?? this.tenants.current(user);
  }

  /**
   * 额度余额与账本流水。
   *
   * 为什么以前没守卫：这两个端点建在 tenant:billing:view 之前，写的时候没有对应 action。
   * 结果是**任何登录成员都能读全租户的余额与流水** —— 那是租户级财务数据，
   * 不是个人数据，越权读实打实存在。现在补上守卫，让这个 action 真的生效。
   */
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tenant:billing:view')
  @Get('current/tokens')
  tokenBalance(@CurrentUser() user: AuthProfile) {
    return this.tenants.tokenBalance(this.activeTenantId(user));
  }

  @UseGuards(PermissionsGuard)
  @RequirePermissions('tenant:billing:view')
  @Get('current/tokens/ledger')
  tokenLedger(@CurrentUser() user: AuthProfile) {
    return this.tenants.tokenLedger(this.activeTenantId(user));
  }

  @UseGuards(PermissionsGuard)
  @RequirePermissions('tenant:token:grant')
  @Post('current/tokens/grant')
  grant(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(grantTokensSchema)) dto: GrantTokensDto,
  ) {
    return this.tenants.grantTokens(this.activeTenantId(user), dto.amount, dto.reason, user.id);
  }

  // TenantGuard 已保证 user.activeTenantId 必填
  private activeTenantId(user: AuthProfile): string {
    return user.activeTenantId as string;
  }
}
