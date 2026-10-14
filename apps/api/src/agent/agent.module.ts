import { Global, Module } from '@nestjs/common';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';

/**
 * Agent 机器接入模块（0.1.53）
 *
 * @Global 是因为 AuditInterceptor 挂在根模块上（要覆盖所有控制器），
 * 它依赖 PrismaService，而 PrismaService 本来就是 @Global 的。
 */
@Global()
@Module({
  // JwtService 由 AuthModule 的 JwtModule 提供（同一 secret / 同一签发参数）
  // AuthModule 提供 JwtService；RbacModule 提供 PermissionsGuard 依赖的 AbilityFactory；
  // TenantsModule 同理提供 TenantGuard 的依赖
  imports: [AuthModule, RbacModule, TenantsModule],
  controllers: [AgentController],
  providers: [AgentService, AuditInterceptor],
  exports: [AgentService, AuditInterceptor],
})
export class AgentModule {}