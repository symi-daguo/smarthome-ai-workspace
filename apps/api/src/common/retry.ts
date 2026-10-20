/**
 * 生成类外部调用的有限重试（2026 年生图/生视频服务的通行做法）。
 *
 * 为什么需要：生图一次 20~30 秒，链路长、失败率高，且**失败在扣费之后**。
 * 用户点一次「生成」遇到网络抖动就白等半分钟还白扣额度，是最容易引发投诉的点。
 *
 * 三条原则：
 * 1. **只重试可重试的错误** —— 超时 / 连接被重置 / 5xx / 429。
 *    4xx（参数错、key 无效）重试多少次都一样，只会白等，必须立刻抛出。
 * 2. **有限次 + 退避** —— 指数退避带抖动，避免多个并发请求同时重试形成尖峰。
 *    参考站的户型图渲染模块用的也是这个量级（重试上限 6 次）。
 * 3. **最后一次把原始错误抛出去** —— 不能用「重试失败」这种含糊文案盖掉真实原因。
 *
 * 刻意不做的事：不重试业务错误（BadRequest）、不做无限重试、不做跨请求的状态机
 * （那是异步出图队列的事，同步调用就该同步返回或明确失败）。
 */

/** 一次尝试的结果包装：区分「可重试」与「立刻失败」 */
export interface AttemptResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

export interface RetryOptions {
  /** 总尝试次数（含第一次）。参考站用 6，这里默认 3：再多用户等不起 */
  attempts?: number;
  /** 首次退避毫秒，之后翻倍 */
  baseDelayMs?: number;
  /** 单次尝试的超时毫秒。0 = 不额外限制（交由调用方/底层库处理） */
  timeoutMs?: number;
  /** 自定义判定：返回 true 表示可重试 */
  isRetryable?: (err: unknown) => boolean;
  /** 进度回调（第几次尝试、已经过多久），用于日志与前端提示 */
  onAttempt?: (attempt: number, total: number, elapsedMs: number, err?: unknown) => void;
}

/** 从任意错误里挖出 HTTP 状态码（fetch Response、axios error、裸 status 都覆盖） */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: unknown };
  const direct = e.status ?? e.statusCode ?? e.response?.status ?? (e.cause as { status?: unknown })?.status;
  return typeof direct === 'number' ? direct : undefined;
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

/**
 * 默认判定：**只重试「再试一次有可能成功」的错误**。
 *
 * - 5xx / 429：服务端临时问题，值得重试
 * - 超时类（AbortError / TimeoutError / ETIMEDOUT / ECONNRESET / ECONNREFUSED /
 *   socket hang up / fetch failed）：网络层抖动，最典型的可重试场景
 * - 4xx（除 429）：参数错 / key 无效 / 额度不足，重试只是让用户多等
 * - 其余（如本项目抛的 BadRequestException）：一律不重试
 */
export function defaultIsRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status <= 599);
  }
  const n = nameOf(err);
  if (n === 'AbortError' || n === 'TimeoutError') return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network|timeout|aborted/i.test(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 带有限重试地执行一次生成调用。
 *
 * 每次尝试都套一层超时（若给了 `timeoutMs`），避免某一次请求挂死把整轮拖成无限等待。
 * **重试只应包裹「真正产生副作用」之前的那段** —— 扣费若在调用之后，
 * 每次重试都会重复扣，所以扣费要么放在全部尝试成功之后，要么由调用方保证幂等。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = Math.max(0, opts.baseDelayMs ?? 1200);
  const timeoutMs = opts.timeoutMs ?? 0;
  const retryable = opts.isRetryable ?? defaultIsRetryable;
  const started = Date.now();
  let lastErr: unknown;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const run = async (): Promise<T> => {
        if (!timeoutMs) return fn();
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const e = new Error(`生成超时（超过 ${Math.round(timeoutMs / 1000)} 秒未返回）`);
                e.name = 'TimeoutError';
                reject(e);
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const value = await run();
      opts.onAttempt?.(i, attempts, Date.now() - started);
      return value;
    } catch (err) {
      lastErr = err;
      opts.onAttempt?.(i, attempts, Date.now() - started, err);
      if (i >= attempts || !retryable(err)) break;
      // 指数退避 + 抖动：多个并发请求不会在同一毫秒一起重试
      const backoff = base * 2 ** (i - 1);
      const jitter = Math.floor(Math.random() * Math.max(1, backoff * 0.3));
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}
