/**
 * 方案页数核算（素材驱动算法）。
 *
 * 为什么要有：页数不是凭空选的固定档位，而是由**沟通模块 + 户型图 + 素材页**算出来的下限。
 * 用户只上传了 3 张户型图却选了 9 页，交付时少 2 页，等于门店交了一份残缺的方案给客户。
 *
 * 两处刻意差异（不改数字，只改机制）：
 * 1. 沟通模块基数用骨架 9 页（`BASE_SKELETON`）—— 9 页版式已实测过零溢出与留白，
 *    改成 10 页会打乱已验证的页面。机制沿用行业通行做法，数字守住自己的设计。
 * 2. 扣费按**最终交付页数**算，不是按用户选的页数：选了 9 但下限是 11，就该扣 11 页的钱，
 *    否则客户拿到 11 页而门店只付了 9 页。
 */

import type { PlanPage } from '../data/planThemes';

/** 沟通模块基数：与后端 BASE_SKELETON 保持一致，改一处要同时改后端 */
export const CORE_MODULES = 9;

export type Edition = 'standard' | 'presale' | 'private';

export interface MaterialCounts {
  /** 户型图总数（第一张算沟通模块的一部分，额外张数才占页） */
  floorplanCount: number;
  /** 素材展示页数（按空间分组折算，不是图片张数） */
  renderCount: number;
}

export interface PageCostInput extends MaterialCounts {
  /** 用户在页面上选的页数 */
  selected: number;
  /** 版式 */
  edition: Edition;
}

/** 单页出图成本（元），由部署者按画质调整 */
const PRICE_PER_PAGE: Record<string, number> = { low: 0.6, medium: 1, high: 1.6 };

/** 自定义页数上限 */
export const PAGE_COUNT_MAX = 20;

/**
 * 素材带来的页数下限：`沟通模块 + 额外户型图 + 素材页`。
 * 私宅版至少留 1 页给场景演示（max(1, render)）。
 */
export function materialPageMinimum(m: MaterialCounts, edition: Edition): number {
  const extraFloorplan = Math.max(0, m.floorplanCount - 1);
  if (edition === 'private') return CORE_MODULES + extraFloorplan + Math.max(1, m.renderCount);
  return CORE_MODULES + extraFloorplan + m.renderCount;
}

/** 夹取到合法范围：NaN 兜底为基数，下限取素材下限，上限 20 */
export function resolvePageCount(selected: number, m: MaterialCounts, edition: Edition): number {
  const n = Number.isFinite(selected) ? Math.round(selected) : CORE_MODULES;
  const min = Math.max(CORE_MODULES, materialPageMinimum(m, edition));
  return Math.max(min, Math.min(PAGE_COUNT_MAX, n));
}

/** 预计出图费用（元）。文案必须写「约」，因为真实费用以最终结算为准 */
export function estimateCost(pages: number, quality: keyof typeof PRICE_PER_PAGE = 'medium'): string {
  const unit = PRICE_PER_PAGE[quality] ?? PRICE_PER_PAGE.medium;
  return (pages * unit).toFixed(2);
}

/** 核算提示文案：公式段 + 扩页说明 */
export function pageCountHint(
  pages: number,
  selected: number,
  m: MaterialCounts,
  edition: Edition,
  quality: keyof typeof PRICE_PER_PAGE = 'medium',
): { formula: string; expansion: string; cost: string } {
  const extraFloorplan = Math.max(0, m.floorplanCount - 1);
  const formula = edition === 'private'
    ? `${CORE_MODULES} 类客户问题 + ${extraFloorplan} 张额外户型图 + ${Math.max(1, m.renderCount)} 个场景演示页 = 至少 ${materialPageMinimum(m, edition)} 页`
    : `${CORE_MODULES} 个沟通模块 + ${extraFloorplan} 张额外户型图 + ${m.renderCount} 个素材展示页 = 至少 ${materialPageMinimum(m, edition)} 页`;

  const expansion = pages === selected
    ? `已选 ${pages} 页，预计实际 ${pages} 页`
    : selected < pages
      ? `已选 ${selected} 页，将自动扩至 ${pages} 页`
      : `当前文案 ${pages} 页，落库时按实际写出的文案页数对齐`;

  return { formula, expansion, cost: `初版出图约 ¥${estimateCost(pages, quality)}` };
}

/**
 * 页序列：把沟通模块页与素材页拼成最终页序列。
 * 目前只有户型图素材（`renderedFloorplan` / `floorplan`），效果图尚未接入（批次 3），
 * 所以素材页只贡献额外户型图页；接通效果图后在这里追加即可，不用改调用方。
 */
export function buildPageSequence(
  basePages: PlanPage[],
  m: MaterialCounts,
  floorplanPage: PlanPage | null,
  edition: Edition,
): PlanPage[] {
  const extra = Math.max(0, m.floorplanCount - 1);
  if (!floorplanPage || extra <= 0) return basePages;
  // 额外户型图先插在动线页之后：先看动线规划，再看整张户型与点位落位
  const at = basePages.findIndex((p) => p.type === 'layout');
  const idx = at < 0 ? CORE_MODULES : at + 1;
  const out = [...basePages];
  for (let i = 0; i < extra; i++) out.splice(idx, 0, { ...floorplanPage, heading: floorplanPage.heading });
  return out;
}
