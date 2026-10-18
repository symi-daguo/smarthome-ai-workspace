import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, BillingModule, RbacModule, LlmModule],
  controllers: [OrdersController],
  providers: [OrdersService, IdempotencyService],
})
export class OrdersModule {}
