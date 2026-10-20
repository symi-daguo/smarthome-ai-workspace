import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeDocController } from './knowledge-doc.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { KnowledgeDocService } from './knowledge-doc.service.js';

@Module({
  imports: [AuthModule, LlmModule, RbacModule],
  controllers: [KnowledgeController, KnowledgeDocController],
  providers: [KnowledgeService, KnowledgeDocService],
  exports: [KnowledgeService, KnowledgeDocService],
})
export class KnowledgeModule {}
