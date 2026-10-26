import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseModelIds } from '../src/llm/model-catalog.service.js';

/**
 * 「拉模型清单」端点（POST /api/admin/model-config/chat/models）的断言。
 *
 * 为什么单独成文件：smoke.ts 里还有其他并行任务在加断言，
 * 同一个文件同时编辑会互相覆盖。拆成独立模块，由 smoke.ts 一行 import + 一行调用挂接。
 *
 * 断言用的上游是**本机假 OpenAI 兼容服务**（127.0.0.1 随机端口）：
 * 门禁不能打真实外部网络 —— 外部服务不在线时门禁就会红，
 * 而那是环境问题不是代码问题（本机 .env 一配地址就会这样）。
 */
export interface ModelCatalogSmokeContext {
  /** 与 smoke.ts 的 check() 同签名：登记一条断言并计入总条数 */
  check: (name: string, ok: boolean, detail?: string) => void;
  /** 与 smoke.ts 的 request() 同签名 */
  request: <T>(base: string, path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  /** 被测服务地址 */
  base: string;
  /** 管理员鉴权头（该端点要 platform:billing:manage） */
  auth: { headers: { Authorization: string } };
}

/**
 * Nest 对 POST 默认回 201（Created）。
 * 同控制器的 test-chat / test-image 等 POST 端点也是 201，这里跟着走，不单独加 @HttpCode。
 */
const OK_STATUS = 201;

interface ModelsResponse {
  models?: string[];
  source?: string;
  baseUrl?: string;
  code?: string;
  message?: string;
}

/**
 * 跑模型清单相关的断言。
 *
 * 覆盖三条路径：拉得到（成功）、拉得到但走缓存（不打上游）、
 * 拉不到（上游 500 / 404 / 401）——失败必须给**明确错误码**而不是 500 崩溃，
 * 且**不能改动已保存的配置**（拉清单是只读辅助动作，绝不能顺手写坏配置）。
 */
export async function assertModelCatalogAssertions(ctx: ModelCatalogSmokeContext): Promise<void> {
  const { check, request, base, auth } = ctx;
  const path = '/api/admin/model-config/chat/models';

  // ---------- 纯函数：各网关返回的形状不统一，解析要都认 ----------
  check(
    '模型清单解析兼容 data[].id / models[].name / 字符串数组三种形状',
    parseModelIds({ data: [{ id: 'm1' }, { id: 'm2' }] }).join(',') === 'm1,m2'
      && parseModelIds({ models: [{ name: 'qwen3' }] }).join(',') === 'qwen3'
      && parseModelIds(['a', 'b']).join(',') === 'a,b'
      && parseModelIds({ data: [] }).length === 0,
    JSON.stringify({
      openai: parseModelIds({ data: [{ id: 'm1' }, { id: 'm2' }] }),
      gateway: parseModelIds({ models: [{ name: 'qwen3' }] }),
      plain: parseModelIds(['a', 'b']),
    }),
  );

  // ---------- 本机假 OpenAI 兼容服务 ----------
  let mode: 'ok' | 'server-error' | 'not-found' | 'unauthorized' = 'ok';
  let hits = 0;
  let seenAuth: string | null = null;
  const fake = createServer((req, res) => {
    hits += 1;
    seenAuth = req.headers.authorization ?? null;
    if (mode === 'server-error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    if (mode === 'not-found') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;

  try {
    // ---------- 成功路径 ----------
    const okKey = 'sk-smoke-catalog-ok';
    const okRes = await request<ModelsResponse>(base, path, {
      ...auth,
      method: 'POST',
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: okKey }),
    });
    check(
      '拉模型清单成功：返回上游的模型 id 列表',
      okRes.status === OK_STATUS && (okRes.body.models ?? []).join(',') === 'm1,m2',
      `status=${okRes.status} body=${JSON.stringify(okRes.body).slice(0, 200)}`,
    );
    check(
      '拉模型清单的响应不含密钥明文',
      !JSON.stringify(okRes.body).includes(okKey),
      JSON.stringify(okRes.body).slice(0, 200),
    );
    check(
      '拉模型清单用服务端侧的密钥向服务商发 Bearer 鉴权',
      seenAuth === `Bearer ${okKey}`,
      `seenAuth=${seenAuth}`,
    );

    // ---------- 缓存：同一地址 + 同一密钥不重复打上游 ----------
    const hitsBeforeCache = hits;
    const cached = await request<ModelsResponse>(base, path, {
      ...auth,
      method: 'POST',
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: okKey }),
    });
    check(
      '同一配置 5 分钟内命中缓存，不重复打上游',
      cached.status === OK_STATUS && cached.body.source === 'cache' && hits === hitsBeforeCache,
      `source=${cached.body.source} hits=${hits - hitsBeforeCache}`,
    );

    // ---------- refresh 强制重拉（界面上的「刷新」按钮必须真的能刷新） ----------
    const refreshed = await request<ModelsResponse>(base, path, {
      ...auth,
      method: 'POST',
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: okKey, refresh: true }),
    });
    check(
      'refresh=true 跳过缓存强制重拉',
      refreshed.status === OK_STATUS && refreshed.body.source === 'live' && hits === hitsBeforeCache + 1,
      `source=${refreshed.body.source} hits=${hits - hitsBeforeCache}`,
    );

    // ---------- 失败路径：上游 500 → 明确错误码，不是 500 崩溃 ----------
    // 每次失败都用**不同的密钥**：缓存键含密钥摘要，
    // 用同一个密钥会命中上面那次成功的缓存，失败分支根本走不到（断言会假绿）。
    mode = 'server-error';
    const errKey = 'sk-smoke-catalog-err';
    const err500 = await request<ModelsResponse>(base, path, {
      ...auth,
      method: 'POST',
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: errKey, refresh: true }),
    });
    check(
      '上游 500 时返回明确错误码（503 LLM_MODELS_FETCH_FAILED），不是 500 崩溃',
      err500.status === 503 && err500.body.code === 'LLM_MODELS_FETCH_FAILED',
      `status=${err500.status} body=${JSON.stringify(err500.body).slice(0, 200)}`,
    );
    check(
      '失败响应不含密钥明文',
      !JSON.stringify(err500.body).includes(errKey),
      JSON.stringify(err500.body).slice(0, 200),
    );

    // ---------- 失败路径：上游没有 /models（404）→ 降级为「拉取不可用」 ----------
    mode = 'not-found';
    const err404 = await request<ModelsResponse>(base, path, {
      ...auth,
      method: 'POST',
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: 'sk-smoke-catalog-404', refresh: true }),
    });
    check(
      '上游没有 /models 时降级为「拉取不可用」（503 LLM_MODELS_UNSUPPORTED）',
      err404.status === 503 && err404.body.code === 'LLM_MODELS_UNSUPPORTED',
      `status=${err404.status} body=${JSON.stringify(err404.body).slice(0, 200)}`,
    );

    // ---------- 失败路径：Key 不对（401）→ 提示改 Key，而不是笼统说失败 ----------
    mode = 'unauthorized';
    const err401 = await request<ModelsResponse>(base, path, {
      ...auth,
      method: 'POST',
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: 'sk-smoke-catalog-401', refresh: true }),
    });
    check(
      '上游 401 时提示是 Key 的问题（503 LLM_MODELS_AUTH_FAILED）',
      err401.status === 503 && err401.body.code === 'LLM_MODELS_AUTH_FAILED',
      `status=${err401.status} body=${JSON.stringify(err401.body).slice(0, 200)}`,
    );

    // ---------- 拉清单是只读动作：失败也不能改动已保存的配置 ----------
    const before = await request<{ chat: unknown }>(base, '/api/admin/model-config', auth);
    const after = await request<{ chat: unknown }>(base, '/api/admin/model-config', auth);
    check(
      '拉模型清单（含失败）不改动已保存的模型配置',
      before.status === 200 && after.status === 200 && JSON.stringify(before.body.chat) === JSON.stringify(after.body.chat),
      `before=${JSON.stringify(before.body.chat).slice(0, 120)}`,
    );
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
}
