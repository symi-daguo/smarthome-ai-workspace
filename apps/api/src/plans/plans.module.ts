import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MediaModule } from '../media/media.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { PlanPackageService } from './plan-package.service.js';
import { PlansController, PlanPackageController, PublicPlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

@Module({
  imports: [AuthModule, BillingModule, LlmModule, MediaModule, RbacModule],
  controllers: [PlansController, PlanPackageController, PublicPlansController],
  providers: [PlansService, PlanPackageService],
})
export class PlansModule {}
