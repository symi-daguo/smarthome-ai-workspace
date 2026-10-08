import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ChatController } from './llm.controller.js';
import { ModelConfigController } from './model-config.controller.js';
import { LlmService } from './llm.service.js';

@Module({
  imports: [ConfigModule, AuthModule, BillingModule, RbacModule],
  controllers: [ChatController, ModelConfigController],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
