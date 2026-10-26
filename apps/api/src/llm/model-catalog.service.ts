import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { fetchUpstream, UPSTREAM_TIMEOUT_MS } from '../common/upstream-timeout.js';
import { ModelConfigService, type ConfigScope } from './model-config.service.js';

/**
 * 模型清单服务：从客户自己配的服务商地址拉「这个 Key 能用哪些模型」。
 *
 * 为什么要它：模型名（如 deepseek-chat / qwen-plus / glm-4-plus）全靠人背，
 * 背错了要等到真的发起对话才报错，而报错来自上游、长得像"模型不存在"，
 * 用户根本不知道是自己拼错了名字。现在填完地址就能从服务商那边把清单拉回来选。
 *
 * 三条硬约束：
 *   1. 密钥只进不出：请求体里可以带**用户刚填的**密钥去问上游，
 *      但任何响应都不含密钥明文；未提供时只用服务端已存的。
 *   2. 不透传上游响应体：只提取模型 id 列表。上游返回什么就回什么的话，
 *      等于把第三方服务的内部结构原样暴露给前端，以后上游改字段就会连带改本项目。
 *   3. 拉不到**不阻断保存**：清单是辅助功能，服务商不支持 /models 是常态
 *      （本地 Ollama 老版本、部分网关都不提供）。失败时抛带明确错误码的异常，
 *      前端据此提示"可手动填写"，保存配置的流程照走。
 *
 * ⚠️ 多租户边界（这一轮**明确不改**，写在这里防止后来人误判）：
 * ModelSetting / ModelProfile 两张表**没有 tenantId** —— 模型配置是**部署级共享**的。
 * 也就是说 A 租户管理员改的 Base URL / API Key，B 租户管理员看到的是同一份，
 * 而且 B 租户发的对话请求会真的用上 A 刚填的 Key（反过来也一样）。
 * 给它们加 tenantId 是独立的大改造（迁移 + 全部读路径 + 前端作用域选择 + 存量归属），
 * 不在本次范围内。在当前结构下，任何"模型配置按租户隔离"的承诺都不成立，
 * 文档与界面上都不能这么写。
 */
@Injectable()
export class ModelCatalogService {
  private readonly logger = new Logger(ModelCatalogService.name);

  /** 进程内缓存：5 分钟内同一地址 + 同一密钥不重复打上游 */
  private readonly cache = new Map<string, { at: number; models: string[] }>();

  constructor(private readonly modelConfig: ModelConfigService) {}

  /**
   * 拉取某项能力的服务商可用模型清单。
   *
   * @param scope  chat / image / video（knowledge 没有 /models 概念）
   * @param query  baseUrl、apiKey 可传**尚未保存**的值（用户填完就想先看清单）；
   *               留空则回落到服务端已保存的配置；refresh=true 跳过缓存强制重拉。
   */
  async listModels(scope: ConfigScope, query: ModelListQuery = {}): Promise<ModelListResult> {
    const saved = await this.savedRuntime(scope);
    const baseUrl = (query.baseUrl ?? '').trim() || saved.baseUrl;
    const apiKey = (query.apiKey ?? '').trim() || saved.apiKey;
    if (!baseUrl) {
      throw new ServiceUnavailableException({
        code: 'LLM_MODELS_NO_BASE_URL',
        message: '尚未配置服务地址，无法拉取模型清单，请先填写 Base URL',
      });
    }
    const key = cacheKey(scope, baseUrl, apiKey);
    if (!query.refresh) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < CATALOG_TTL_MS) {
        return { models: hit.models, source: 'cache', baseUrl };
      }
    }
    const models = await this.fetchModels(baseUrl, apiKey);
    this.remember(key, models);
    return { models, source: 'live', baseUrl };
  }

  /**
   * 真正去打上游。
   *
   * 超时用独立的 models 档（10 秒）而不是对话那档（240 秒）：
   * 这是纯元数据请求，服务商不支持 /models 时不该让页面干等 4 分钟。
   */
  private async fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    let res: Response;
    try {
      res = await fetchUpstream(
        url,
        { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
        UPSTREAM_TIMEOUT_MS.models,
        'LLM',
        '模型清单服务',
        {
          unreachable: '模型服务连不上，请检查模型配置里的服务地址',
          invalidUrl: '模型服务地址格式不对，请检查是否完整（含 http:// 或 https://）',
        },
      );
    } catch (e) {
      // fetchUpstream 已把网络层错误翻成可读文案（超时/连不上/证书），
      // 这里只把错误码前缀换成 LLM_MODELS_，让调用方一眼看出是"拉清单失败"而不是"对话失败"。
      const code = responseCode(e);
      if (code.startsWith('LLM_')) {
        throw new ServiceUnavailableException({
          code: `LLM_MODELS_${code.slice('LLM_'.length)}`,
          message: errorMessage(e),
        });
      }
      this.logger.warn(`拉取模型清单失败 ${url}: ${errorMessage(e)}`);
      throw new ServiceUnavailableException({
        code: 'LLM_MODELS_FETCH_FAILED',
        message: '拉取模型清单失败：无法连接模型服务，请检查服务地址与网络',
      });
    }

    if (!res.ok) {
      // 401/403 与 5xx 是两件事：前者是 Key 不对（改 Key），后者是服务侧的问题（等会儿再试）。
      // 混成一句话，用户就会在"改 Key"和"换地址"之间来回瞎试。
      if (res.status === 401 || res.status === 403) {
        throw new ServiceUnavailableException({
          code: 'LLM_MODELS_AUTH_FAILED',
          message: `模型服务拒绝认证（${res.status}），请检查 API Key 是否正确`,
        });
      }
      if (res.status === 404 || res.status === 405) {
        throw new ServiceUnavailableException({
          code: 'LLM_MODELS_UNSUPPORTED',
          message: '该服务未提供 /models 模型清单接口，请手动填写模型名',
        });
      }
      throw new ServiceUnavailableException({
        code: 'LLM_MODELS_FETCH_FAILED',
        message: `模型服务返回 ${res.status}，请检查服务地址与 API Key`,
      });
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      // 返回的不是 JSON（例如服务商把 404 页面当 200 回了）→ 当作"不支持清单"，
      // 而不是"解析失败"：用户要做的动作是手动填模型名，不是重试。
      throw new ServiceUnavailableException({
        code: 'LLM_MODELS_UNSUPPORTED',
        message: '该服务返回的不是 OpenAI 兼容的模型清单，请手动填写模型名',
      });
    }
    const models = parseModelIds(payload);
    if (models.length === 0) {
      throw new ServiceUnavailableException({
        code: 'LLM_MODELS_UNSUPPORTED',
        message: '未从该服务解析到可用模型，请手动填写模型名',
      });
    }
    return models;
  }

  /** 已保存的运行配置（密钥只在服务端内部用，不出现在任何响应里） */
  private async savedRuntime(scope: ConfigScope): Promise<{ baseUrl: string; apiKey: string }> {
    if (scope === 'chat') {
      const c = await this.modelConfig.chatConfig();
      return { baseUrl: c.baseUrl, apiKey: c.apiKey ?? '' };
    }
    if (scope === 'image') {
      const c = await this.modelConfig.imageConfig();
      return { baseUrl: c.baseUrl, apiKey: c.apiKey ?? '' };
    }
    if (scope === 'video') {
      const c = await this.modelConfig.videoConfig();
      return { baseUrl: c.baseUrl, apiKey: c.apiKey ?? '' };
    }
    return { baseUrl: '', apiKey: '' };
  }

  private remember(key: string, models: string[]): void {
    // 缓存条数上限：地址与密钥组合理论上可以无限多，不设限就是内存泄漏的入口。
    if (this.cache.size >= CATALOG_CACHE_MAX && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest === 'string') this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), models });
  }
}

/** 清单缓存有效期：5 分钟。够挡住"多人同时开页面重复打上游"，又不至于长期给过期清单 */
const CATALOG_TTL_MS = 5 * 60_000;
/** 缓存条数上限 */
const CATALOG_CACHE_MAX = 64;

export interface ModelListQuery {
  /** 未保存的服务地址（用户刚填的）；留空则用服务端已保存的 */
  baseUrl?: string;
  /** 未保存的 API Key（用户刚填的）；留空则用服务端已存的 */
  apiKey?: string;
  /** true=跳过缓存强制重拉（界面上的「刷新」按钮） */
  refresh?: boolean;
}

export interface ModelListResult {
  /** 模型 id 列表（只含 id，不含上游响应体的其他内容） */
  models: string[];
  /** live=本次真拉的；cache=命中 5 分钟内的缓存 */
  source: 'live' | 'cache';
  /** 实际请求的地址（不含密钥），供界面说明"从哪拉的" */
  baseUrl: string;
}

/**
 * 从上游响应里提取模型 id 列表。
 *
 * 兼容三种常见形状（OpenAI 兼容协议并没有强制统一，各家网关差别很大）：
 *   - `{ data: [{ id: 'gpt-4o' }] }`   —— OpenAI 兼容标准
 *   - `{ models: [{ name: 'qwen3' }] }` —— 部分网关 / Ollama 老版本
 *   - `['gpt-4o', 'gpt-4o-mini']`       —— 极简实现
 * 外加单模型形态 `{ name: 'xxx' }`。
 *
 * 只取字符串 id，不把上游的其他字段带出去。
 */
export function parseModelIds(payload: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) out.push(s);
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['id', 'name', 'model', 'model_name']) {
        const s = typeof o[k] === 'string' ? (o[k] as string).trim() : '';
        if (s) {
          out.push(s);
          return;
        }
      }
    }
  };
  const list = (arr: unknown): void => {
    if (Array.isArray(arr)) for (const item of arr) push(item);
  };
  if (Array.isArray(payload)) {
    list(payload);
  } else if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.data)) list(o.data);
    else if (Array.isArray(o.models)) list(o.models);
    else push(o);
  }
  // 去重 + 排序：下拉框要有稳定顺序，重复项只会让人多点一次
  return [...new Set(out)].sort();
}

/** 缓存键含密钥摘要（不存明文）：同一地址换了 Key，清单结果可能完全不同，必须分开缓存 */
function cacheKey(scope: string, baseUrl: string, apiKey: string): string {
  const digest = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : 'nokey';
  return `${scope}|${baseUrl}|${digest}`;
}

/** Nest 的异常体放在 getResponse() 里，不是实例上的 code 字段 —— 直接读 e.code 永远读到空 */
function responseCode(e: unknown): string {
  const resp = (e as { getResponse?: () => unknown })?.getResponse?.();
  const code = (resp as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
