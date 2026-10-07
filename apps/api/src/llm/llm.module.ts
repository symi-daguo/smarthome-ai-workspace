import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ChatController, LlmController } from './llm.controller.js';
import { LlmService } from './llm.service.js';

@Module({
  imports: [ConfigModule, AuthModule, BillingModule, RbacModule],
  controllers: [LlmController, ChatController],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
