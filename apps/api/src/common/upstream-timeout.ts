import { ServiceUnavailableException } from '@nestjs/common';

/**
 * 外部模型/素材服务的统一超时闸门
 *
 * 背景：此前所有对外部模型的调用都没有超时。一次实测里模型侧响应变慢，
 * `POST /api/plans` 挂住 5 分钟不返回（Node 默认等响应头 300 秒），
 * 界面一直转圈，用户既看不到原因也走不掉 —— 更糟的是它已经把额度预扣了。
 *
 * 这里只做一件事：**到点就失败，并说清楚是谁超时**。
 * 超时时长按各链路的正常耗时给，不追求最短 —— 让快请求永远不受影响。
 */
export const UPSTREAM_TIMEOUT_MS = {
  /** 对话/方案生成：一次要吐 9 页 JSON，是全项目最慢的一次调用 */
  llm: 240_000,
  /** 生图：MiniMax/OpenAI 兼容端点出图 */
  image: 180_000,
  /** 生视频只提交任务，不等生成结果 */
  videoSubmit: 60_000,
  /** 轮询任务状态的单次请求（生视频 / ComfyUI 出图） */
  poll: 30_000,
  /**
   * 生视频**轮询阶段的总预算**：不管单次请求快慢，轮询整体到点就停。
   *
   * 为什么要总预算而不只是单次超时：单次请求各有各的快慢，
   * 只限单次的话，总时长会被 N 次慢请求累加出来，突破外层的等待上限 ——
   * 结果就是用户看到「网关超时」而不是服务端那句明确的「视频生成超时」。
   */
  videoPollBudget: 480_000,
  /** 素材下载（图/视频文件回传） */
  download: 120_000,
} as const;

/** 超时转成对外可读的错误码后缀，便于前端与 Agent 判断该重试还是改配置 */
export type UpstreamKind = 'LLM' | 'IMAGE' | 'VIDEO' | 'DOWNLOAD';

/**
 * 带超时的外部请求。
 *
 * 超时抛 ServiceUnavailableException（503）而不是笼统的 500：
 * 503 对前端与 Agent 的含义是「服务暂时不可用，可以稍后重试」，
 * 与「参数错了」「没权限」区分开，重试策略才不会用错。
 */
/**
 * 把底层网络失败翻译成对外可读的错误码与文案。
 *
 * Node 的原始报错是 "fetch failed"、cause 里躺着一串 ECONNREFUSED / ENOTFOUND，
 * 直接透出去等于把开发语言甩给门店人员。这里统一翻成「连不上 / 超时」两类，
 * 并带上能指路的提示（查服务地址、查网络、等一会儿再试）。
 *
 * 返回 null 表示「不是已知的网络失败」，交给调用方按自己的方式处理。
 */
export function describeUpstreamError(
  e: unknown,
  kind: UpstreamKind,
  label: string,
  timeoutMs?: number,
): { code: string; message: string } | null {
  const err = e as { name?: string; message?: string; cause?: unknown };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    const seconds = timeoutMs ? Math.round(timeoutMs / 1000) : 0;
    return {
      code: `${kind}_TIMEOUT`,
      message: seconds
        ? `${label}超时（超过 ${seconds} 秒未返回），请稍后重试`
        : `${label}超时，请稍后重试`,
    };
  }
  const codes: string[] = [];
  const cause = err?.cause as { code?: string; errors?: { code?: string }[] } | undefined;
  if (cause?.code) codes.push(cause.code);
  for (const sub of cause?.errors ?? []) if (sub?.code) codes.push(sub.code);
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) {
    return {
      code: `${kind}_UNREACHABLE`,
      message: `${label}服务地址解析失败，请检查模型配置里的服务地址`,
    };
  }
  if (
    codes.includes('ECONNREFUSED')
    || codes.includes('ECONNRESET')
    || codes.includes('EHOSTUNREACH')
    || codes.includes('ENETUNREACH')
    || codes.includes('EPIPE')
  ) {
    return {
      code: `${kind}_UNREACHABLE`,
      message: `${label}服务连不上，请检查网络或模型配置里的服务地址`,
    };
  }
  return null;
}

/**
 * 带超时的外部请求。
 *
 * 超时抛 ServiceUnavailableException（503）而不是笼统的 500：
 * 503 对前端与 Agent 的含义是「服务暂时不可用，可以稍后重试」，
 * 与「参数错了」「没权限」区分开，重试策略才不会用错。
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  kind: UpstreamKind,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const described = describeUpstreamError(e, kind, label, timeoutMs);
    if (described) {
      throw new ServiceUnavailableException({ code: described.code, message: described.message });
    }
    throw e;
  }
}
