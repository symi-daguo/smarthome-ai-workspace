import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MediaModule } from '../media/media.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { PlansController, PublicPlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

@Module({
  imports: [AuthModule, BillingModule, LlmModule, MediaModule, RbacModule],
  controllers: [PlansController, PublicPlansController],
  providers: [PlansService],
})
export class PlansModule {}
