import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BenchmarkController } from './benchmark.controller.js';
import { BenchmarkService } from './benchmark.service.js';
import { BenchmarkAnalyzeService } from './benchmark-analyze.service.js';

/**
 * 对标账号情报模块。
 *
 * 依赖 KnowledgeModule 是为了把分析结论**投影成一份知识库资料**——
 * 这样智能体在对话里检索时能学到对标账号的表达方式，而不只是给人看。
 *
 * 依赖 RbacModule 是因为控制器上的 PermissionsGuard 要用 AbilityFactory。
 */
@Module({
  imports: [RbacModule, KnowledgeModule, LlmModule],
  controllers: [BenchmarkController],
  providers: [BenchmarkService, BenchmarkAnalyzeService],
})
export class BenchmarkModule {}
