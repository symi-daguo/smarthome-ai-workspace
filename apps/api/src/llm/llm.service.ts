import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * OpenAI 兼容 chat 客户端（多模型适配层）
 *
 * 客户自部署时通过 env 选择任意 OpenAI 兼容端点：
 *   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（如 DeepSeek、通义千问、智谱、Kimi、OpenAI、
 *   本地 Ollama/LM Studio/vLLM 等）。
 * 未设置 LLM_* 时回退到 MiniMax_*（向后兼容 0.1.x 默认），再回退到 MiniMax 官方端点。
 * 模型名解析：显式配置 LLM_MODEL 时全局锁定该模型；否则沿用调用方传入的 model。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly config: ConfigService) {}

  /** 当前对话服务的基础 URL（去尾部斜杠） */
  get baseUrl(): string {
    const base =
      this.config.get<string>('LLM_BASE_URL') ||
      this.config.get<string>('MiniMax_BASE_URL', 'https://api.minimaxi.com/v1');
    return base.replace(/\/+$/, '');
  }

  private endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  /** 当前对话服务的 API Key（LLM_ 优先，回退 MiniMax_） */
  get apiKey(): string | undefined {
    return this.config.get<string>('LLM_API_KEY') || this.config.get<string>('MiniMax_API_KEY');
  }

  /** 显式配置的模型名（空串视为未配置，返回 undefined 交由调用方传入值决定） */
  get configuredModel(): string | undefined {
    return this.config.get<string>('LLM_MODEL') || undefined;
  }

  /** 解析实际使用的模型：锁定 env 的 LLM_MODEL，否则用传入值 */
  private resolveModel(inputModel: string): string {
    return this.configuredModel ?? inputModel;
  }

  async chat(input: {
    model: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
  }): Promise<{ reply: string; model: string; latencyMs: number }> {
    const key = this.apiKey;
    if (!key || key === 'replace-me') {
      throw new ServiceUnavailableException({
        code: 'LLM_KEY_MISSING',
        message: '对话模型 API Key 未配置（LLM_API_KEY 或 MiniMax_API_KEY），请在 .env 中填入',
      });
    }

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });

    const model = this.resolveModel(input.model);
    const start = Date.now();
    const response = await fetch(this.endpoint(), {
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
  isConfigured(): boolean {
    const key = this.apiKey;
    return Boolean(key && key !== 'replace-me');
  }

  /**
   * 结构化 JSON 抽取：要求模型只返回符合字段说明的 JSON 对象。
   * 解析失败或 key 未配置时抛出，由调用方降级。
   */
  async chatObject<T extends Record<string, string>>(input: {
    model?: string;
    systemPrompt: string;
    prompt: string;
  }): Promise<T> {
    const { reply } = await this.chat({
      model: input.model ?? 'MiniMax-M3',
      maxTokens: 2048,
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
  }): Promise<T> {
    const { reply } = await this.chat({
      model: 'MiniMax-M3',
      maxTokens: input.maxTokens ?? 8192,
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
