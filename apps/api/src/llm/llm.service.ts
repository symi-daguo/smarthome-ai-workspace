import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 极简 MiniMax（M-series）客户端
 *
 * 0.1.1：直接调用 MiniMax OpenAI 兼容端点，便于本地快速验证 API key
 * 0.2.0：替换为 LiteLLM 网关（统一模型路由 / 预算 / Guardrails）
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly config: ConfigService) {}

  private endpoint(): string {
    const base = this.config.get<string>('MiniMax_BASE_URL', 'https://api.minimaxi.com/v1');
    return `${base.replace(/\/+$/, '')}/chat/completions`;
  }

  private apiKey(): string | undefined {
    return this.config.get<string>('MiniMax_API_KEY');
  }

  async chat(input: {
    model: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
  }): Promise<{ reply: string; model: string; latencyMs: number }> {
    const key = this.apiKey();
    if (!key || key === 'replace-me') {
      throw new ServiceUnavailableException({
        code: 'LLM_KEY_MISSING',
        message: 'MiniMax_API_KEY 未配置，请在 .env 中填入',
      });
    }

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });

    const start = Date.now();
    const response = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: input.model,
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
        message: `MiniMax 返回 ${response.status}`,
        upstream: body.slice(0, 200),
      });
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    // MiniMax-M3 等推理模型会把思考过程包在  内一并返回，剥离后再交付
    const reply = (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return { reply, model: data.model ?? input.model, latencyMs };
  }

  /** 是否可用（用于调用方在 key 缺失时降级到规则通道） */
  isConfigured(): boolean {
    const key = this.apiKey();
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
