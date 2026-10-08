import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { KnowledgeRuntime } from '../llm/model-config.service.js';

/**
 * 外部知识库适配器（纯 HTTP，不引入框架）：
 *   - weknora  ：腾讯开源 WeKnora（客户本机 docker compose 拉起，后端默认 :8080），
 *                X-API-Key 认证；跨库语义检索 POST {base}/knowledge-search
 *   - obsidian ：Obsidian Local REST API 插件（默认 http://127.0.0.1:27124），
 *                Bearer 认证；全文检索 POST {base}/search/simple?query=...，
 *                命中后 GET /vault/{path} 拉取笔记内容做上下文片段
 * 统一返回 KnowledgeChunk[]，供各板块 agent 注入 system prompt。
 */
const logger = new Logger('KnowledgeAdapter');

export interface KnowledgeChunk {
  title: string;
  content: string;
  score: number;
  source: string;
}

const MAX_CHUNKS = 5;
const MAX_CHARS = 1600;

async function fetchJson(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** WeKnora 检索：POST /knowledge-search { query, knowledge_base_ids? } */
async function searchWeknora(cfg: KnowledgeRuntime, query: string): Promise<KnowledgeChunk[]> {
  const kbIds = cfg.kbIds ? cfg.kbIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const res = await fetchJson(`${cfg.baseUrl}/knowledge-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey ?? '' },
    body: JSON.stringify({ query, ...(kbIds?.length ? { knowledge_base_ids: kbIds } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ServiceUnavailableException({ code: 'WEKNORA_SEARCH_FAILED', message: `WeKnora 返回 ${res.status}：${body.slice(0, 160)}` });
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { results?: { content?: string; chunk_info?: { content?: string }; knowledge_filename?: string; knowledge_title?: string; score?: number }[] }[];
  } | null;
  const results = data?.data?.[0]?.results ?? [];
  return results.slice(0, MAX_CHUNKS).map((r) => ({
    title: r.knowledge_filename || r.knowledge_title || 'WeKnora 片段',
    content: (r.content ?? r.chunk_info?.content ?? '').slice(0, MAX_CHARS),
    score: Number(r.score ?? 0),
    source: 'weknora',
  }));
}

/** Obsidian 检索：POST /search/simple?query=... 得到文件与匹配位置，再拉取内容片段 */
async function searchObsidian(cfg: KnowledgeRuntime, query: string): Promise<KnowledgeChunk[]> {
  const url = `${cfg.baseUrl}/search/simple?query=${encodeURIComponent(query)}&contextLength=300`;
  const res = await fetchJson(url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey ?? ''}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ServiceUnavailableException({ code: 'OBSIDIAN_SEARCH_FAILED', message: `Obsidian 返回 ${res.status}：${body.slice(0, 160)}` });
  }
  const hits = (await res.json().catch(() => [])) as { filename: string; score?: number; matches?: { context?: string }[] }[];
  const chunks: KnowledgeChunk[] = [];
  for (const h of hits.slice(0, MAX_CHUNKS)) {
    let content = h.matches?.map((m) => m.context ?? '').join('\n').trim() ?? '';
    if (!content) {
      // 匹配上下文为空时回退拉取笔记头部
      try {
        const note = await fetchJson(`${cfg.baseUrl}/vault/${h.filename.split('/').map(encodeURIComponent).join('/')}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey ?? ''}`, Accept: 'text/markdown' },
        });
        if (note.ok) content = (await note.text()).slice(0, MAX_CHARS);
      } catch {
        // 单篇拉取失败跳过
      }
    }
    if (content) chunks.push({ title: h.filename, content: content.slice(0, MAX_CHARS), score: Number(h.score ?? 0), source: 'obsidian' });
  }
  return chunks;
}

export async function searchExternalKnowledge(cfg: KnowledgeRuntime, query: string): Promise<KnowledgeChunk[]> {
  if (!cfg.enabled || cfg.provider === 'none' || !cfg.baseUrl) return [];
  try {
    if (cfg.provider === 'obsidian') return await searchObsidian(cfg, query);
    return await searchWeknora(cfg, query);
  } catch (e) {
    if (e instanceof ServiceUnavailableException) throw e;
    logger.warn(`外部知识库检索失败（${cfg.provider}）: ${e instanceof Error ? e.message : String(e)}`);
    throw new ServiceUnavailableException({ code: 'KNOWLEDGE_UNREACHABLE', message: `无法连接外部知识库（${cfg.provider} @ ${cfg.baseUrl}）` });
  }
}

/** 连通性探测：weknora=GET /knowledge-bases，obsidian=GET /（插件根路径返回服务状态） */
export async function pingExternalKnowledge(cfg: KnowledgeRuntime): Promise<{ ok: boolean; detail?: string; error?: string }> {
  if (cfg.provider === 'none') return { ok: false, error: '未配置外部知识库 provider' };
  try {
    if (cfg.provider === 'obsidian') {
      const res = await fetchJson(`${cfg.baseUrl}/`, { headers: { Authorization: `Bearer ${cfg.apiKey ?? ''}` } }, 8000);
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Obsidian 认证失败，请检查 API Key' };
      if (!res.ok) return { ok: false, error: `Obsidian 返回 ${res.status}，请确认已安装并启用 Local REST API 插件` };
      return { ok: true, detail: `Obsidian Local REST API 在线：${cfg.baseUrl}` };
    }
    const res = await fetchJson(`${cfg.baseUrl}/knowledge-bases`, { headers: { 'X-API-Key': cfg.apiKey ?? '' } }, 8000);
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'WeKnora 认证失败，请检查 API Key' };
    if (!res.ok) return { ok: false, error: `WeKnora 返回 ${res.status}，请确认服务已启动（默认 http://127.0.0.1:8080）` };
    const data = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
    return { ok: true, detail: `WeKnora 在线，可见知识库 ${data?.data?.length ?? '?'} 个：${cfg.baseUrl}` };
  } catch (e) {
    return { ok: false, error: `无法连接（${cfg.baseUrl}）：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 把检索片段拼为注入 system prompt 的参考上下文（无结果返回空串） */
export function formatKnowledgeContext(chunks: KnowledgeChunk[]): string {
  if (!chunks.length) return '';
  const lines = chunks.map((c, i) => `【资料${i + 1}·${c.title}】\n${c.content}`);
  return `\n\n以下是客户知识库中的相关资料，回答时优先参考并注明来源文件名：\n${lines.join('\n\n')}`;
}
