import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MediaController, MediaFileController } from './media.controller.js';
import { MediaService } from './media.service.js';

@Module({
  imports: [ConfigModule, AuthModule, BillingModule, RbacModule, LlmModule],
  controllers: [MediaController, MediaFileController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
