import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  imports: [BillingModule, RbacModule],
  controllers: [TenantsController],
  providers: [TenantsService, TenantGuard],
})
export class TenantsModule {}
