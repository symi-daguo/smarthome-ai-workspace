/**
 * 方案的「渲染页序列」。
 *
 * 为什么要有这个：门店上传了户型图，方案里却没有一页专门展示它 ——
 * 空间动线页的图只占三成宽，客户现场看不清点位。参考站的页数公式
 * 把户型图算成独立页（`app.js:3427`：`核心模块 + 额外户型图 + 素材展示页`）。
 *
 * 为什么不写进数据库：这一页没有文案，完全由已上传的素材推导出来。
 * 存进去反而要处理「素材被替换/删除后这页怎么办」，而重新渲染一次就解决。
 * 代价是 `versionNo` 不因它 +1 —— 对门店来说没有影响，因为校对状态管的是文案。
 *
 * 插在 `layout` 页之后：先看动线规划，再看整张户型和每个点位落位。
 */
import type { PlanPage } from '../data/planThemes';
import { floorplanTemplate, markerTemplate } from '../data/planTemplates';

/** 插入的户型页文案固定：它是图示页，不是文案页，门店不需要逐页改写 */
const FLOORPLAN_PAGE: PlanPage = {
  type: 'floorplan',
  heading: '户型与设备点位',
  subtitle: '每一台设备装在哪，一张图说清',
  body: '以您家的实际户型为底图，把中控、面板、传感与窗帘电机的落位逐一点出。施工前会与您和装修方再核对一次水电预留位置。',
  quote: '点位落定，水电一次做对',
  bullets: [],
  narration: '这张图是按您家户型做的点位图。每个图标对应一台设备，我们会按施工顺序进场。点位如果有调整，随时在图上标出来就行。',
};

/**
 * 有户型图才插页：没上传素材却多一页空白，客户只会当成没做完。
 *
 * 返回插入位置 `syntheticAt`（没插时为 -1），调用方保存编辑前用它把索引
 * 映射回真实页：编辑、扣费、版本号全都按 `plan.pages` 走，虚拟页不参与。
 */
export function withFloorplanPage(
  pages: PlanPage[],
  hasFloorplan: boolean,
): { pages: PlanPage[]; syntheticAt: number; virtualAt: number[] } {
  const ok = hasFloorplan && !pages.some((p) => p.type === 'floorplan');
  if (!ok) return { pages, syntheticAt: -1, virtualAt: [] };
  const at = pages.findIndex((p) => p.type === 'layout');
  const idx = at < 0 ? 3 : at + 1;
  const next = [...pages];
  next.splice(idx, 0, { ...FLOORPLAN_PAGE });
  return { pages: next, syntheticAt: idx, virtualAt: [idx] };
}

/**
 * 点位清单续页：超过一页容量的点位**必须**转页，不能只画前 N 条。
 *
 * 为什么这么较真：点位表是施工交底的依据，漏一条设备就等于那台设备装不装没定。
 * 一份「看起来完整但少列了几台设备」的交付件比明显缺页更危险——客户不会去数，
 * 只会照着单子签字。
 *
 * 续页沿用首页的图与正文，只改标题/副标题；编号由调用方按原始点位数组下标算，
 * 不会错位。
 */
export const POINT_ROWS_PER_PAGE = 9;

/** 需要几张点位清单页（含首页） */
export function pointListPageCount(pointCount: number): number {
  return pointCount <= 0 ? 1 : Math.ceil(pointCount / POINT_ROWS_PER_PAGE);
}

/** 在户型页之后插入清单续页；`floorplanIndex` 是户型页在 outPages 里的下标 */
export function withPointListPages(
  pages: PlanPage[],
  floorplanIndex: number,
  pointCount: number,
): { pages: PlanPage[]; insertedAt: number[] } {
  const need = pointListPageCount(pointCount);
  if (need <= 1 || floorplanIndex < 0) return { pages, insertedAt: [] };
  // 校验目标确实是户型页：只判下标范围的话，传错下标会把续页插到封面后面，
  // 客户会看到「封面 → 设备点位清单（续） → 户型图」这种错序。
  if (pages[floorplanIndex]?.type !== 'floorplan') return { pages, insertedAt: [] };
  // 续页的 type 同样是 'floorplan'，只能靠计数区分「首页」与「续页」。
  // 已有清单页够数就不再插 —— 否则把已算好的页序再喂回来会多出续页。
  const have = pages.reduce((n, p) => (p.type === 'floorplan' ? n + 1 : n), 0);
  const extra = need - have;
  if (extra <= 0) return { pages, insertedAt: [] };
  // 续页接在**最后一张**清单页之后：接在首页之后的话，已有续页时新页会插到旧续页前面，
  // 页序就乱了。编号由 floorplanListPageNo 按位置算，插在末尾自然连续。
  let last = floorplanIndex;
  for (let k = 0; k < pages.length; k += 1) if (pages[k].type === 'floorplan') last = k;
  const src = pages[floorplanIndex];
  const next = [...pages];
  const insertedAt: number[] = [];
  for (let k = 1; k <= extra; k += 1) {
    next.splice(last + k, 0, {
      ...src,
      heading: '设备点位清单（续）',
      // 页码按「已有张数 + 本次序号」算：首页是第 1 页，
      // 部分续页已存在时不能从 2 重新数，否则页码会重复。
      subtitle: `第 ${have + k} / ${need} 页 · 共 ${pointCount} 台设备`,
      quote: undefined,
    });
    insertedAt.push(last + k);
  }
  return { pages: next, insertedAt };
}

/**
 * 第 `i` 页（整份 PPT 的下标）属于第几张点位清单页。
 *
 * 续页与首页 type 同为 'floorplan'，靠「它前面有几个 floorplan 页」来定位，
 * 不靠标题文字匹配 —— 标题可能被门店改过。
 */
export function floorplanListPageNo(pages: PlanPage[], i: number): number {
  let n = 0;
  for (let k = 0; k < i && k < pages.length; k += 1) if (pages[k].type === 'floorplan') n += 1;
  return n;
}

/**
 * 交付页序列的输入：只要「有没有户型图」「有多少点位」「用哪套模版」三件事。
 * PPTX、讲稿、分享页都从这里取页序。
 */
export interface DeliveryPlanLike {
  pages: PlanPage[];
  floorplanUrl?: string | null;
  renderedFloorplanUrl?: string | null;
  layoutPoints?: unknown[] | null;
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
}

/**
 * 点位清单是否走「编号列表」版式。
 *
 * render 模版不叠加点位、icon 模版的标记是产品图（编号无意义），这两种都退回品类汇总。
 */
export function deliverPointCount(plan: DeliveryPlanLike): number {
  if (floorplanTemplate(plan.floorplanTemplate) === 'render') return 0;
  if (markerTemplate(plan.markerTemplate) === 'icon') return 0;
  return plan.layoutPoints?.length ?? 0;
}

/**
 * 交付页序列 —— **唯一来源**。
 *
 * PPTX、完整讲稿、分享页、方案预览四处必须拿到同一份页序：
 * 门店照着讲稿讲，客户翻 PPT 对不上页就是事故。
 * 以前这几处各写一遍插页逻辑，改一处忘另一处就会静默错位
 * （实测讲稿少户型页与点位清单页，PPT 却是全的）。
 *
 * `virtualAt` 是虚拟页（户型页 + 点位清单续页）在结果里的下标：
 * 真实页没有文案，编辑、扣费、版本号都按 `plan.pages` 走，
 * 前端编辑时要用它把视图下标映射回真实页下标。
 */
export function deliverPages(plan: DeliveryPlanLike): { pages: PlanPage[]; virtualAt: number[] } {
  const fp = withFloorplanPage(plan.pages, Boolean(plan.floorplanUrl || plan.renderedFloorplanUrl));
  const fpIndex = fp.pages.findIndex((p) => p.type === 'floorplan');
  if (fpIndex < 0) return { pages: fp.pages, virtualAt: [] };
  const list = withPointListPages(fp.pages, fpIndex, deliverPointCount(plan));
  return { pages: list.pages, virtualAt: [...fp.virtualAt, ...list.insertedAt].sort((a, b) => a - b) };
}
