import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LightingController } from './lighting.controller.js';
import { LightingService, LightingDiagnosisService } from './lighting.service.js';

@Module({
  imports: [RbacModule, LlmModule, BillingModule],
  controllers: [LightingController],
  providers: [LightingService, LightingDiagnosisService],
})
export class LightingModule {}
