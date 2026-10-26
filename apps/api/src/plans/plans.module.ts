import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MediaModule } from '../media/media.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { PlanPackageService } from './plan-package.service.js';
import { PlanPreflightService } from './plan-preflight.service.js';
import { NarrationAudioService } from './narration-audio.service.js';
import { PlanPageImagesController } from './plan-page-images.controller.js';
import { PlanPageImagesService } from './plan-page-images.service.js';
import { PlansController, PlanPackageController, PlanNarrationAudioFileController, PublicPlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

@Module({
  imports: [AuthModule, BillingModule, LlmModule, MediaModule, RbacModule],
  // 路由注册顺序 = 数组顺序：PlanPageImagesController 必须排在 PlansController 前面 ——
  // PlansController 的 `@Get(':id')` 会吃掉 `/api/plans/page-images`（单段通配），
  // 请求会被当成「取 id=page-images 的方案」而 404。详见 plan-page-images.controller.ts 的注释。
  controllers: [PlanPageImagesController, PlansController, PlanPackageController, PlanNarrationAudioFileController, PublicPlansController],
  providers: [PlansService, PlanPackageService, PlanPreflightService, NarrationAudioService, PlanPageImagesService],
})
export class PlansModule {}
