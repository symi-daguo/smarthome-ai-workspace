import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModelConfigService } from './model-config.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { formatKnowledgeContext, searchExternalKnowledge } from '../knowledge/knowledge-adapter.js';
import { rankLocalChunks } from '../knowledge/knowledge-doc.service.js';
import { fetchUpstream, UPSTREAM_TIMEOUT_MS } from '../common/upstream-timeout.js';

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

/** OpenAI 兼容的多模态内容块 */
type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** 单个附件的字符上限：再多也会被模型截断，白白占 token */
const ATTACH_TEXT_LIMIT = 8000;

/**
 * 把附件真正组装进用户消息。
 *
 * **修复的是「看似能用、实则完全没用」**：此前前端只把「文件名(类型,大小)」拼进
 * 提示词，模型只收到一行 `[附件 a.pdf(PDF, 123KB)]`——用户以为 AI 读过附件了。
 *
 * 三类分开处理，因为它们对模型的价值完全不同：
 * - 图片 → 传 `image_url` 块，模型能**看**
 * - 文本类（txt/md/csv/json）→ 解 base64 内联，模型能**读**
 * - PDF/zip 等二进制 → **不假装给了内容**，明确告知未附带并引导去「内容提取」
 *   （那里已有 mammoth/pdfjs 的解析能力，不在这里重复造一遍）
 *
 * 导出供 smoke 直接断言：这段逻辑决定了"用户以为 AI 看过附件"是不是真的，
 * 属于不能只靠人工看一眼的部分。
 */
export function buildUserContent(
  prompt: string,
  attachments?: { name: string; dataUrl: string }[],
): string | ChatContentPart[] {
  if (!attachments?.length) return prompt;
  const parts: ChatContentPart[] = [{ type: 'text', text: prompt }];
  const unreadable: string[] = [];
  for (const a of attachments) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(a.dataUrl);
    if (!m) {
      unreadable.push(a.name);
      continue;
    }
    const mime = m[1].toLowerCase();
    if (mime.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    } else if (mime.startsWith('text/') || mime === 'application/json') {
      const text = Buffer.from(m[2], 'base64').toString('utf8');
      const cut = text.length > ATTACH_TEXT_LIMIT ? `\n…（已截断，原文共 ${text.length} 字）` : '';
      parts.push({ type: 'text', text: `【附件 ${a.name}】\n${text.slice(0, ATTACH_TEXT_LIMIT)}${cut}` });
    } else {
      unreadable.push(a.name);
    }
  }
  if (unreadable.length) {
    parts.push({
      type: 'text',
      text: `（附件 ${unreadable.join('、')} 属 PDF/压缩包类二进制，本次**未附带内容**，不要假设你看过它们；需要读取请到「内容提取」上传后引用。）`,
    });
  }
  // 没有任何附件真的带上了内容时，退回纯字符串：部分模型对纯文本数组格式兼容不好
  return parts.length === 1 ? prompt : parts;
}

/**
 * 从模型回复里抠出**第一个完整的 JSON 值**。
 *
 * ## 为什么不能用 lastIndexOf 找结尾
 *
 * 原来的写法是「取第一个 `{`，再取最后一个 `}`，中间整段当 JSON」。
 * 踩过的坑：模型在 JSON 后面又输出了一段话（或干脆输出了两个 JSON），
 * 于是截出来的是 `{...} 的说明文字 {第二个 JSON}` 这种拼接串，
 * `JSON.parse` 直接报 "Unexpected non-whitespace character after JSON at position N"。
 * 报错位置还落在中间，肉眼看不出是哪一步错位——很难定位。
 *
 * 改成**括号配平扫描**：从第一个 `{` 或 `[` 开始，遇到字符串就跳过
 * （JSON 字符串里可能有 `{` `}`，不算结构），括号深度归零的那一刻就是结尾。
 * 这样即使后面跟着解释文字、第二个 JSON、markdown 围栏，都能取到第一个完整值。
 *
 * 导出供 smoke 直接断言：这段逻辑决定了「模型返回了带说明的 JSON」时能不能解析成功，
 * 不能只靠人工看一眼。
 */
export function extractJsonValue(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // 括号没配平（被 max_tokens 截断）：交给调用方按解析失败处理
  return null;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly modelConfig: ModelConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** 知识库检索并拼上下文；外部引擎优先，不可用时回落到内置本地资料库 */
  private async ragContext(rag: RagContext, fallbackQuery: string): Promise<string> {
    const query = (rag.query ?? fallbackQuery).slice(0, 300);
    try {
      const cfg = await this.modelConfig.knowledgeConfig();
      if (cfg.enabled && cfg.provider !== 'none' && cfg.baseUrl) {
        const chunks = await searchExternalKnowledge(cfg, query);
        await this.audit(rag, `${(rag.query ?? fallbackQuery).slice(0, 60)} -> ${chunks.length} hits (${cfg.provider})`);
        return formatKnowledgeContext(chunks);
      }
    } catch (e) {
      // 外部引擎不可达不应让对话失败——回落到本地资料库，这正是零配置兜底的意义
      this.logger.warn(`外部知识库不可用，回落本地资料库（${rag.scene}）: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const docs = await this.prisma.knowledgeDoc.findMany({
        where: { tenantId: rag.tenantId, enabled: true },
        select: { title: true, content: true },
      });
      const local = rankLocalChunks(docs, query);
      await this.audit(rag, `${(rag.query ?? fallbackQuery).slice(0, 60)} -> ${local.length} hits (local)`);
      return formatKnowledgeContext(local);
    } catch (e) {
      this.logger.warn(`本地资料库检索降级（${rag.scene}）: ${e instanceof Error ? e.message : String(e)}`);
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
    /** 覆盖本次请求的上游超时（批量结构化任务要用更短的超时，失败要能快速重试） */
    timeoutMs?: number;
    rag?: RagContext;
    /** 附件 dataURL；图片走多模态、文本类内联、二进制明确告知未附带 */
    attachments?: { name: string; dataUrl: string }[];
  }): Promise<{ reply: string; model: string; latencyMs: number }> {
    const cfg = await this.modelConfig.chatConfig();
    const key = cfg.apiKey;
    if (!key) {
      throw new ServiceUnavailableException({
        code: 'LLM_KEY_MISSING',
        message: '对话模型 API Key 未配置，请在「系统管理 → 模型配置」中填写，或在 .env 设置 LLM_API_KEY',
      });
    }

    const messages: { role: 'system' | 'user'; content: string | ChatContentPart[] }[] = [];
    let system = input.systemPrompt ?? '';
    if (input.rag) system += await this.ragContext(input.rag, input.prompt);
    if (system.trim()) messages.push({ role: 'system', content: system.trim() });
    messages.push({ role: 'user', content: buildUserContent(input.prompt, input.attachments) });

    const model = cfg.model ?? input.model;
    const start = Date.now();
    const response = await fetchUpstream(
      `${cfg.baseUrl}/chat/completions`,
      {
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
      },
      input.timeoutMs ?? UPSTREAM_TIMEOUT_MS.llm,
      'LLM',
      '模型对话',
    );    const latencyMs = Date.now() - start;

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
   *
   * 约束放宽为 `Record<string, unknown>`（原为 `Record<string, string>`）：
   * 模型输出的字段不都是字符串——接单解析就要返回场景数组、系统三态对象、预算数字。
   * 调用方负责做运行时白名单过滤与转型，这里不做臆测。
   */
  async chatObject<T extends Record<string, unknown>>(input: {
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

    const jsonText = extractJsonValue(
      reply
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    );
    if (!jsonText) throw new Error('LLM_JSON_PARSE_FAILED');
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
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
   *
   * `model` 可以覆盖默认模型，但**用户在「模型配置」里设的模型优先**
   * （`chat()` 里是 `cfg.model ?? input.model`）——
   * 所以这里只是给「这类任务更适合某个模型」留个口子，不会盖掉用户的设置。
   */
  async chatJson<T>(input: {
    systemPrompt: string;
    prompt: string;
    model?: string;
    maxTokens?: number;
    /** 覆盖上游超时（批量任务要能快速失败重试，不能干等 4 分钟） */
    timeoutMs?: number;
    rag?: RagContext;
  }): Promise<T> {
    const { reply } = await this.chat({
      model: input.model ?? 'MiniMax-M3',
      maxTokens: input.maxTokens ?? 8192,
      timeoutMs: input.timeoutMs,
      rag: input.rag,
      systemPrompt: `${input.systemPrompt}\n只返回一个 JSON 值（对象或数组），不要输出 markdown 代码块、解释或多余文字。`,
      prompt: input.prompt,
    });
    const jsonText = extractJsonValue(
      reply
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    );
    if (!jsonText) throw new Error('LLM_JSON_PARSE_FAILED');
    return JSON.parse(jsonText) as T;
  }
}
