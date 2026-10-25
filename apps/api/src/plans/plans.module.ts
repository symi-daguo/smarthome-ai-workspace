import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MediaModule } from '../media/media.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { PlanPackageService } from './plan-package.service.js';
import { PlanPreflightService } from './plan-preflight.service.js';
import { NarrationAudioService } from './narration-audio.service.js';
import { PlansController, PlanPackageController, PlanNarrationAudioFileController, PublicPlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

@Module({
  imports: [AuthModule, BillingModule, LlmModule, MediaModule, RbacModule],
  controllers: [PlansController, PlanPackageController, PlanNarrationAudioFileController, PublicPlansController],
  providers: [PlansService, PlanPackageService, PlanPreflightService, NarrationAudioService],
})
export class PlansModule {}
