import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { TenantGuard } from '../tenants/tenant.guard.js';
import { DesktopOnlyGuard } from './desktop-only.guard.js';
import { DesktopConfigController } from './desktop-config.controller.js';
import { DesktopConfigService } from './desktop-config.service.js';

/**
 * 桌面端设置模块。
 *
 * 守卫的依赖来自三处：AuthModule（JwtStrategy，让 `AuthGuard('jwt')` 有策略可用）、
 * RbacModule（PermissionsGuard 与 AbilityFactory）、TenantGuard（多租户解析）。
 * TenantGuard 在本模块里单独提供一份 —— 它是无状态的小守卫，
 * 各模块自己提供是这个项目既有的做法（见 tenants.module.ts）。
 */
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [DesktopConfigController],
  providers: [DesktopConfigService, DesktopOnlyGuard, TenantGuard],
})
export class DesktopModule {}
