const TOKEN_KEY = 'sas_token';

export const tokenStore = {
  get(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/** img/video/下载链接无法携带 Authorization 头，以 ?token= 查询参数认证（本地部署形态） */
export function fileUrl(path: string): string {
  const token = tokenStore.get();
  const sep = path.includes('?') ? '&' : '?';
  return token ? `${path}${sep}token=${encodeURIComponent(token)}` : path;
}

/** 常规接口超时：绝大多数请求秒级完成 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 生图：服务端最多等模型 3 分钟 */
export const IMAGE_TIMEOUT_MS = 200_000;
/**
 * 生成方案：服务端最多等模型 4 分钟，**格式异常时会重试一次**，
 * 所以最坏要等两轮 —— 这里必须按两轮算，否则界面会先于服务端放弃，
 * 用户看到的是"卡住"，而不是服务端那句明确的重试提示。
 */
export const PLAN_TIMEOUT_MS = 600_000;
/** 生视频：服务端轮询生成结果最长约 8 分钟 */
export const VIDEO_TIMEOUT_MS = 700_000;

export interface ApiInit extends RequestInit {
  /** 该请求的超时上限（毫秒）。长任务必须显式放宽，否则会被默认上限先掐断 */
  timeoutMs?: number;
}

/** 统一请求封装：自动附带 Bearer Token, 非 2xx 抛出 Error(message) */
export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const headers: Record<string, string> = {};
  // FormData 由浏览器自动设置 multipart boundary，不能手动指定 Content-Type
  const isForm = typeof FormData !== 'undefined' && rest?.body instanceof FormData;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  const base = import.meta.env.VITE_API_BASE_URL ?? '';
  // 自己管超时：浏览器 fetch 默认无限等，接口卡住时界面只会一直转圈，
  // 用户既看不到原因也走不掉（只能刷新，重复提交还可能重复扣额度）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...rest, headers, signal: controller.signal });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') {
      throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒未返回），请稍后重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    // 把后端的 code 一并带出来：否则前端只能靠文案匹配判断是哪类错误，
    // 改个字面量就静默失效。Nest 的异常体本身就是 { code, message }。
    const err = new Error(body?.message ?? response.statusText) as Error & { code?: string; status?: number };
    if (body?.code) err.code = body.code;
    err.status = response.status;
    throw err;
  }
  // DELETE/204 等空响应体：response.json() 会抛 SyntaxError，先取 text 再解析
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
