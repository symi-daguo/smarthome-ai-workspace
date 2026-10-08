import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModelConfigService } from './model-config.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { formatKnowledgeContext, searchExternalKnowledge } from '../knowledge/knowledge-adapter.js';

/**
 * OpenAI 兼容 chat 客户端（多模型适配层）
 *
 * 配置来源优先级：数据库（「模型配置」页在线保存，即时生效）> .env
 *   （LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，未设置回退 MiniMax_*）。
 * 支持任意 OpenAI 兼容端点：DeepSeek、通义千问、智谱、Kimi、OpenAI、MiniMax、
 * 本地 Ollama / LM Studio / vLLM 等。
 * 模型名解析：显式配置模型时全局锁定；否则沿用调用方传入的 model。
 * RAG 联动：传入 rag 上下文时自动检索外部知识库（WeKnora/Obsidian）注入 system prompt，
 *   检索失败降级为无知识库模式不阻塞主链路，操作写入审计留痕。
 */
export interface RagContext {
  tenantId: string;
  userId?: string;
  /** 场景标识（chat / order-intake / plan 等），用于审计 */
  scene: string;
  /** 检索 query（缺省用 prompt） */
  query?: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly modelConfig: ModelConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** 外部知识库检索并拼上下文；异常降级空串 + 审计 */
  private async ragContext(rag: RagContext, fallbackQuery: string): Promise<string> {
    try {
      const cfg = await this.modelConfig.knowledgeConfig();
      if (!cfg.enabled || cfg.provider === 'none') return '';
      const chunks = await searchExternalKnowledge(cfg, (rag.query ?? fallbackQuery).slice(0, 300));
      await this.audit(rag, `${(rag.query ?? fallbackQuery).slice(0, 60)} -> ${chunks.length} hits`);
      return formatKnowledgeContext(chunks);
    } catch (e) {
      this.logger.warn(`知识库检索降级（${rag.scene}）: ${e instanceof Error ? e.message : String(e)}`);
      await this.audit(rag, `${(rag.query ?? fallbackQuery).slice(0, 60)} -> degraded`);
      return '';
    }
  }

  private async audit(rag: RagContext, target: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: { tenantId: rag.tenantId, actorId: rag.userId ?? null, action: 'knowledge.search', target: `${rag.scene}:${target}` },
      });
    } catch {
      // 留痕失败不阻塞业务
    }
  }

  async chat(input: {
    model: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    rag?: RagContext;
  }): Promise<{ reply: string; model: string; latencyMs: number }> {
    const cfg = await this.modelConfig.chatConfig();
    const key = cfg.apiKey;
    if (!key) {
      throw new ServiceUnavailableException({
        code: 'LLM_KEY_MISSING',
        message: '对话模型 API Key 未配置，请在「系统管理 → 模型配置」中填写，或在 .env 设置 LLM_API_KEY',
      });
    }

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    let system = input.systemPrompt ?? '';
    if (input.rag) system += await this.ragContext(input.rag, input.prompt);
    if (system.trim()) messages.push({ role: 'system', content: system.trim() });
    messages.push({ role: 'user', content: input.prompt });

    const model = cfg.model ?? input.model;
    const start = Date.now();
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: input.maxTokens ?? 512,
      }),
    });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn(`LLM ${response.status}: ${body.slice(0, 200)}`);
      throw new ServiceUnavailableException({
        code: 'LLM_UPSTREAM_ERROR',
        message: `模型服务返回 ${response.status}`,
        upstream: body.slice(0, 200),
      });
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    // 推理模型（MiniMax-M3、DeepSeek-R1 等）可能把思考过程包在  内一并返回，剥离后再交付
    const reply = (data.choices?.[0]?.message?.content ?? '').replace(/[\s\S]*?<\/think>\s*/g, '').trim();
    return { reply, model: data.model ?? model, latencyMs };
  }

  /** 是否可用（用于调用方在 key 缺失时降级到规则通道） */
  async isConfigured(): Promise<boolean> {
    const cfg = await this.modelConfig.chatConfig();
    return Boolean(cfg.apiKey);
  }

  /**
   * 结构化 JSON 抽取：要求模型只返回符合字段说明的 JSON 对象。
   * 解析失败或 key 未配置时抛出，由调用方降级。
   */
  async chatObject<T extends Record<string, string>>(input: {
    model?: string;
    systemPrompt: string;
    prompt: string;
    rag?: RagContext;
  }): Promise<T> {
    const { reply } = await this.chat({
      model: input.model ?? 'MiniMax-M3',
      maxTokens: 2048,
      rag: input.rag,
      systemPrompt: `${input.systemPrompt}\n只返回一个 JSON 对象，不要输出 markdown 代码块、解释或多余文字。值为字符串，无法识别的字段给空字符串。`,
      prompt: input.prompt,
    });

    const jsonText = reply
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('LLM_JSON_PARSE_FAILED');
    const parsed = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>;
    const result = {} as T;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') (result as Record<string, string>)[key] = value.trim();
      else if (value != null) (result as Record<string, string>)[key] = String(value);
    }
    return result;
  }

  /**
   * 结构化 JSON 生成：返回任意 JSON 值（对象/数组），保留嵌套结构。
   * 用于方案页等需要数组的场景；解析失败抛错由调用方处理。
   */
  async chatJson<T>(input: {
    systemPrompt: string;
    prompt: string;
    maxTokens?: number;
    rag?: RagContext;
  }): Promise<T> {
    const { reply } = await this.chat({
      model: 'MiniMax-M3',
      maxTokens: input.maxTokens ?? 8192,
      rag: input.rag,
      systemPrompt: `${input.systemPrompt}\n只返回一个 JSON 值（对象或数组），不要输出 markdown 代码块、解释或多余文字。`,
      prompt: input.prompt,
    });
    const objStart = reply.indexOf('{');
    const arrStart = reply.indexOf('[');
    const first = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
    if (first === -1) throw new Error('LLM_JSON_PARSE_FAILED');
    const end = reply.lastIndexOf(first === arrStart ? ']' : '}');
    if (end === -1) throw new Error('LLM_JSON_PARSE_FAILED');
    return JSON.parse(reply.slice(first, end + 1)) as T;
  }
}
