import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import { ModelConfigService } from '../llm/model-config.service.js';
import { formatKnowledgeContext, pingExternalKnowledge, searchExternalKnowledge, type KnowledgeChunk } from './knowledge-adapter.js';

/**
 * 外部知识库服务：检索 + 操作留痕（AuditLog）。
 * retrieveContext() 供各板块 agent 联动调用：未启用/检索失败返回空串（降级不阻塞主链路），
 * 失败原因记日志与审计，成功检索记审计（action=knowledge.search）。
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelConfig: ModelConfigService,
  ) {}

  async status() {
    const cfg = await this.modelConfig.knowledgeConfig();
    return {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      kbIds: cfg.kbIds,
      enabled: cfg.enabled,
      source: cfg.source,
      keyConfigured: cfg.provider === 'none' ? false : Boolean(cfg.apiKey),
      keyMasked: cfg.apiKey ? `••••${cfg.apiKey.slice(-4)}` : null,
    };
  }

  async save(dto: { provider?: string; baseUrl?: string; apiKey?: string; kbIds?: string; enabled?: string }, actorId: string) {
    await this.modelConfig.save('knowledge', dto as Record<string, string>, actorId);
  }

  async reset() {
    await this.modelConfig.reset('knowledge');
  }

  async test() {
    const cfg = await this.modelConfig.knowledgeConfig();
    return pingExternalKnowledge(cfg);
  }

  /** 管理端手动检索（知识库页演示用） */
  async search(tenantId: string, userId: string, query: string): Promise<KnowledgeChunk[]> {
    const cfg = await this.modelConfig.knowledgeConfig();
    const chunks = await searchExternalKnowledge(cfg, query);
    await this.audit(tenantId, userId, query, chunks.length, true);
    return chunks;
  }

  /**
   * agent 联动入口：返回可直接拼进 system prompt 的参考上下文。
   * 任何异常降级为空串（主链路不因外部知识库不可用而中断），并留痕。
   */
  async retrieveContext(tenantId: string, userId: string | undefined, scene: string, query: string): Promise<string> {
    try {
      const cfg = await this.modelConfig.knowledgeConfig();
      if (!cfg.enabled || cfg.provider === 'none') return '';
      const chunks = await searchExternalKnowledge(cfg, query.slice(0, 300));
      await this.audit(tenantId, userId ?? null, `${scene}:${query.slice(0, 60)}`, chunks.length, true);
      return formatKnowledgeContext(chunks);
    } catch (e) {
      this.logger.warn(`知识库检索降级（${scene}）: ${e instanceof Error ? e.message : String(e)}`);
      await this.audit(tenantId, userId ?? null, `${scene}:failed`, 0, false);
      return '';
    }
  }

  private async audit(tenantId: string, actorId: string | null, target: string, hits: number, ok: boolean): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: { tenantId, actorId, action: 'knowledge.search', target: `${target} -> ${ok ? `${hits} hits` : 'degraded'}` },
      });
    } catch {
      // 留痕失败不阻塞业务
    }
  }
}
