import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

@Module({
  imports: [LlmModule, RbacModule],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
