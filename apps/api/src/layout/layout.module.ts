import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MediaModule } from '../media/media.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { LayoutController } from './layout.controller.js';
import { LayoutService } from './layout.service.js';

@Module({
  imports: [AuthModule, RbacModule, BillingModule, LlmModule, MediaModule],
  controllers: [LayoutController],
  providers: [LayoutService, IdempotencyService],
})
export class LayoutModule {}
