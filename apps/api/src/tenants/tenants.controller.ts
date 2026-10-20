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
  rename(@CurrentUser() user: AuthProfile, @Body(new ZodValidationPipe(updateTenantSchema)) dto: UpdateTenantDto) {
    return this.tenants.rename(user.activeTenantId as string, dto.name);
  }

  @Get('current')
  current(@CurrentUser() user: AuthProfile) {
    return this.tenants.current(user);
  }

  @Get('current/tokens')
  tokenBalance(@CurrentUser() user: AuthProfile) {
    return this.tenants.tokenBalance(this.activeTenantId(user));
  }

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
