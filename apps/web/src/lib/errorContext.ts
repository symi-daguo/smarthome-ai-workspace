/**
 * 问题上下文收集器
 *
 * 上下文机制（功能定位 / 操作记录 / 请求记录 / 版本号）：
 * 用户报错时自动附上「在哪个功能、
 * 刚做了什么、最近哪个请求失败、什么版本」，排查效率数量级提升——
 * 用户不该负责复述操作路径。
 *
 * 只在内存中，不落盘、不上报；仅当用户主动提交反馈时随表单附带。
 */

/**
 * 记录失败请求由 lib/api.ts 在请求出错时直接调用（那边是所有请求的唯一出口）。
 * 这里不 import api —— 否则 api.ts ↔ errorContext.ts 会成循环依赖。
 */

export interface ErrorContext {
  /** 失败请求摘要（最近 5 条） */
  failedRequests: { at: string; path: string; message: string }[];
  /** 用户操作轨迹（最近 8 条） */
  actions: { at: string; text: string }[];
  /** 当时所在路由 */
  route: string;
  /** 应用版本 */
  version: string;
}

const MAX_REQ = 5;
const MAX_ACT = 8;
// 版本号由 vite.config.ts 从仓库根 package.json 注入（单一事实源），不在这里手写——
// 手写会与 CHANGELOG/根版本各自漂移，报错上下文里的版本号就失去定位价值。
// 用可选链：check:pptx-render.mjs 会用 Node 直接 import 本模块，而 Node 里没有 import.meta.env。
const APP_VERSION: string = import.meta.env?.VITE_APP_VERSION ?? '0.0.0';

const failedRequests: ErrorContext['failedRequests'] = [];
const actions: ErrorContext['actions'] = [];
let route = typeof location !== 'undefined' ? location.pathname + location.hash : '';
let lastError: string | null = null;

/**
 * 时间戳：本地时刻（HH:mm:ss）。
 *
 * 为什么不用 `toISOString().slice(11, 19)`：那是 **UTC** 时刻 ——
 * 东八区用户看到的时间比实际早 8 小时（晚上 8 点提交反馈，记录里写的是 12:00），
 * 用户拿这段时间去对照自己的操作记录会以为系统乱了。
 * `toLocaleTimeString('sv')` 就是本地 HH:mm:ss，不用手搓 padStart。
 */
function stamp(): string {
  return new Date().toLocaleTimeString('sv');
}

/** 记录一次用户操作（去重，避免连点刷屏） */
export function recordAction(text: string): void {
  const label = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!label) return;
  const prev = actions[actions.length - 1];
  if (prev && prev.text === label) return;
  actions.push({ at: stamp(), text: label });
  if (actions.length > MAX_ACT) actions.shift();
}

/** 记录一个失败请求（路径 + 错误文案） */
export function recordFailedRequest(path: string, message: string): void {
  failedRequests.push({ at: stamp(), path: path.replace(/\?.*$/, ''), message: String(message).slice(0, 120) });
  if (failedRequests.length > MAX_REQ) failedRequests.shift();
}

/** 记录最近一次未捕获异常，供反馈页提示 */
export function recordLastError(message: string): void {
  lastError = String(message).slice(0, 200);
}

export function getLastError(): string | null {
  return lastError;
}

/** 路由变化时记录（由 MainLayout 或路由守卫调用） */
export function trackRoute(path: string): void {
  route = path;
  recordAction(`进入 ${path}`);
}

export function snapshot(): ErrorContext {
  return {
    failedRequests: [...failedRequests],
    actions: [...actions],
    route,
    version: APP_VERSION,
  };
}

/** 清空（提交成功后调用，避免下一单混入旧上下文） */
export function clearContext(): void {
  failedRequests.length = 0;
  actions.length = 0;
  lastError = null;
  route = typeof location !== 'undefined' ? location.pathname + location.hash : '';
}

/** 把上下文渲染成人可读文本，随反馈一起提交 */
export function formatContext(ctx: ErrorContext = snapshot()): string {
  const lines: string[] = [`版本：${ctx.version}`, `页面：${ctx.route}`];
  if (ctx.actions.length) {
    lines.push(`最近操作：${ctx.actions.map((a) => `${a.at} ${a.text}`).join(' → ')}`);
  }
  if (ctx.failedRequests.length) {
    lines.push(`失败请求：${ctx.failedRequests.map((r) => `${r.at} ${r.path} → ${r.message}`).join(' | ')}`);
  }
  return lines.join('\n');
}

// 全局兜底：未捕获异常也记下来，用户下次反馈时能带上
if (typeof window !== 'undefined') {
  window.addEventListener('error', (ev) => recordLastError(ev.message || 'script error'));
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    recordLastError(r instanceof Error ? r.message : String(r));
  });
}
