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

/** 统一请求封装：自动附带 Bearer Token, 非 2xx 抛出 Error(message) */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  // FormData 由浏览器自动设置 multipart boundary，不能手动指定 Content-Type
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  const base = import.meta.env.VITE_API_BASE_URL ?? '';
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? response.statusText);
  }
  // DELETE/204 等空响应体：response.json() 会抛 SyntaxError，先取 text 再解析
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
