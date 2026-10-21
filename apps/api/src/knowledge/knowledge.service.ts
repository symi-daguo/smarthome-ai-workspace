import { Injectable, Logger } from '@nestjs/common';
import { ModelConfigService } from '../llm/model-config.service.js';
import { pingExternalKnowledge, searchExternalKnowledge, type KnowledgeChunk } from './knowledge-adapter.js';

/**
 * 外部知识库服务：配置读写 + 检索 + 检索留痕（运行日志）。
 *
 * 对话时的 RAG 上下文拼装在 LlmService.ragContext 里（外部库不可达则回落本地资料库），
 * 本服务只负责「管理端手动检索」这一条路径。
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(private readonly modelConfig: ModelConfigService) {}

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
  async search(query: string): Promise<KnowledgeChunk[]> {
    const cfg = await this.modelConfig.knowledgeConfig();
    const chunks = await searchExternalKnowledge(cfg, query);
    this.audit(query, chunks.length, true);
    return chunks;
  }

  private audit(target: string, hits: number, ok: boolean): void {
    // 检索留痕走日志，不写审计表。
    //
    // 审计表回答的是「谁改了什么」，只记写操作（见 agent/audit.interceptor.ts）。
    // 检索是读操作，而且常由一次写请求内部触发（例如对话时拼 RAG 上下文），
    // 写进审计表既与拦截器记的那条写请求重复，又因为 service 层拿不到 HTTP 上下文
    // 而缺 method/path/requestId —— 半截记录反而让审计无法按 requestId 串联。
    // 检索明细属于运行日志的范畴。
    this.logger.log(`知识库检索 ${target} -> ${ok ? `${hits} hits` : 'degraded'}`);
  }
}
