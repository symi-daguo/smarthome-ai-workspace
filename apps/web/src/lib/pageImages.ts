import { api, fileUrl } from './api';
import { setPageImageOverrides } from '../data/planThemes';

/**
 * 页型配图（租户级）的接口封装。
 *
 * 为什么单独一个模块而不是塞进 pages/PlanImages.tsx：
 * 「导出方案前把门店配的图拉下来写进覆盖表」这件事**发生在方案页**，
 * 而「配图页管理它」发生在配图页 —— 两处都要用同一套接口与同一份覆盖表口径，
 * 放在一处就只有一个真相。
 */

/** 单条页型配图（服务端返回） */
export interface PageImageEntry {
  mediaAssetId: string;
  url: string;
}

/** 本租户已配置的页型配图：{ pageType: { mediaAssetId, url } } */
export type PageImageMap = Record<string, PageImageEntry>;

/**
 * 读取本租户已配置的页型配图，写进运行时覆盖表。
 *
 * 导出 PPTX 前必须调一次：覆盖表为空时导出会用写死的兜底图，
 * 门店配的图就丢了。
 *
 * 为什么 url 要在这里补上登录 token：
 * 素材文件流走 `?token=` 认证（浏览器 <img> / fetch 都不能带 Authorization 头）。
 * 少了 token，服务端回的是 401 的 JSON —— PPTX 里那张图就是空的，
 * 而且界面上一片正常，很难发现。
 */
export async function loadPageImageOverrides(): Promise<PageImageMap> {
  const map = await api<PageImageMap>('/api/plans/page-images');
  const flat: Record<string, string> = {};
  for (const [pageType, item] of Object.entries(map ?? {})) {
    if (!item?.url) continue;
    flat[pageType] = fileUrl(item.url);
  }
  setPageImageOverrides(flat);
  return map ?? {};
}

/** 保存某页型的配图（新建或覆盖） */
export async function savePageImage(pageType: string, mediaAssetId: string): Promise<void> {
  await api<PageImageEntry>(`/api/plans/page-images/${encodeURIComponent(pageType)}`, {
    method: 'PUT',
    body: JSON.stringify({ mediaAssetId }),
  });
}

/** 清除某页型的配图（回到写死的兜底图） */
export async function clearPageImage(pageType: string): Promise<void> {
  await api<void>(`/api/plans/page-images/${encodeURIComponent(pageType)}`, { method: 'DELETE' });
}

/**
 * 导出 PPTX 前刷新覆盖表；**失败不阻断导出**。
 *
 * 为什么失败也要继续导出：取不到配图配置时回落写死的默认实景图，
 * 仍然是一份能交付的方案 —— 比起「导出直接报错」，这个降级明显更好。
 * （没配过配图的部署本来就走默认值，行为与改动前完全一致。）
 */
export async function refreshPageImageOverrides(): Promise<void> {
  try {
    await loadPageImageOverrides();
  } catch (e) {
    console.warn('[页型配图] 读取失败，本次导出使用默认图', (e as Error).message);
  }
}
