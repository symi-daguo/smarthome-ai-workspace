/**
 * 方案的「渲染页序列」。
 *
 * 为什么要有这个：门店上传了户型图，方案里却没有一页专门展示它 ——
 * 空间动线页的图只占三成宽，客户现场看不清点位。页数公式
 * 把户型图算成独立页（`app.js:3427`：`核心模块 + 额外户型图 + 素材展示页`）。
 *
 * 为什么不写进数据库：这一页没有文案，完全由已上传的素材推导出来。
 * 存进去反而要处理「素材被替换/删除后这页怎么办」，而重新渲染一次就解决。
 * 代价是 `versionNo` 不因它 +1 —— 对门店来说没有影响，因为校对状态管的是文案。
 *
 * 插在 `layout` 页之后：先看动线规划，再看整张户型和每个点位落位。
 */
import type { PlanPage } from '../data/planThemes';
import { floorplanTemplate, markerTemplate, floorplanPageCopy, type FloorplanTemplate } from '../data/planTemplates';

/**
 * 有户型图才插页：没上传素材却多一页空白，客户只会当成没做完。
 *
 * 插入的文案随模版变（`floorplanPageCopy`）：compare / render 的画面上
 * 没有编号徽章，用「逐一点出落位」那段文案就是在骗客户。
 *
 * 返回插入位置 `syntheticAt`（没插时为 -1），调用方保存编辑前用它把索引
 * 映射回真实页：编辑、扣费、版本号全都按 `plan.pages` 走，虚拟页不参与。
 */
export function withFloorplanPage(
  pages: PlanPage[],
  hasFloorplan: boolean,
  tpl: FloorplanTemplate = 'annotated',
): { pages: PlanPage[]; syntheticAt: number; virtualAt: number[] } {
  const ok = hasFloorplan && !pages.some((p) => p.type === 'floorplan');
  if (!ok) return { pages, syntheticAt: -1, virtualAt: [] };
  const at = pages.findIndex((p) => p.type === 'layout');
  const idx = at < 0 ? 3 : at + 1;
  const next = [...pages];
  next.splice(idx, 0, { type: 'floorplan', ...floorplanPageCopy(tpl), bullets: [] });
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

/**
 * 设备清单与报价的一行。
 *
 * 口径：**按点位聚合**——同一款设备在平面图上有几个点就算几台，
 * 单价取产品库的参考零售价。这样清单与点位图天然一一对应，
 * 客户对着平面图就能核对清单，不需要信任任何一份「大概的预算」。
 */
export interface QuoteItem {
  name: string;
  category: string;
  /** 台数（同款设备在平面图上的点位个数） */
  qty: number;
  /** 参考零售价（元/台） */
  unitPrice: number;
  /** 小计 = qty × unitPrice */
  subtotal: number;
}

/** 报价汇总 */
export interface QuoteSummary {
  items: QuoteItem[];
  /** 设备参考零售合计（元） */
  total: number;
  /** 台数合计 */
  deviceCount: number;
  /** 品类数 */
  kindCount: number;
  /** 安装调试费率（百分比，租户级设置） */
  installRate: number;
  /** 安装调试费（元）= 设备合计 × 费率 */
  installFee: number;
  /** 整包合计（元）= 设备合计 + 安装调试费 */
  grandTotal: number;
}

/** 报价页的固定文案：它是表页，文案只做口径说明，不逐条罗列 */
const QUOTE_PAGE: PlanPage = {
  type: 'quote',
  heading: '设备清单与报价',
  subtitle: '每一台设备、每一笔价格，都可逐条核对',
  body: '下表是本方案实际选用的设备与参考零售价，数量与上一页的点位一一对应。安装调试费按设备价的一定比例计取，比例由门店在工作台设置里定。辅材与特殊施工费用按现场实际情况另计，最终报价以门店方案师现场核算为准。',
  quote: '每一台设备都对得上号',
  bullets: [],
  narration: '这是本方案的实际设备清单，每一项的数量都和上一页的点位图一一对应。上面的合计是设备价加上按比例算的安装调试费，辅材与特殊施工费用我们会按您家的现场情况单独核算后给到您。',
};

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
 * 第 `i` 页属于第几张报价页。
 *
 * 与 floorplanListPageNo 同一套算法：靠「它前面有几个 quote 页」定位，
 * 不靠标题文字匹配 —— 标题可能被门店改过。
 */
export function quoteListPageNo(pages: PlanPage[], i: number): number {
  let n = 0;
  for (let k = 0; k < i && k < pages.length; k += 1) if (pages[k].type === 'quote') n += 1;
  return n;
}

/** 报价页每页放多少行（表头另算） */
export const QUOTE_ROWS_PER_PAGE = 14;

/** 需要几张报价页（含首页） */
export function quotePageCount(kindCount: number): number {
  return kindCount <= 0 ? 0 : Math.ceil(kindCount / QUOTE_ROWS_PER_PAGE);
}

/**
 * 在「预算规划」页之前插入「设备清单与报价」页。
 *
 * 为什么挨着预算页：设备清单（按点位算出来的实际价）与预算规划（工程口径的区间）
 * 是同一件事的两个视角，放在一起客户的疑问当场有着落 ——
 * 「设备才 1 万，预算为什么写 5 万？」答案是辅材与人工，页面上写明了。
 * 放前面（紧跟点位清单）会被需求页和生态页隔开，两张表对不上。
 *
 * **必须分页而不是截断**：报价单少列几项，客户会以为那几项不用买。
 * 设备种类多的时候（复式/大平层）一页放不下，所以按 QUOTE_ROWS_PER_PAGE 转页，
 * 页序与点位清单页同一套规则。
 *
 * 没有报价数据就不插页：空表页在交付件里等于「没做完」。
 */
export function withQuotePages(
  pages: PlanPage[],
  summary?: QuoteSummary | null,
): { pages: PlanPage[]; insertedAt: number[] } {
  const need = quotePageCount(summary?.items.length ?? 0);
  if (!need) return { pages, insertedAt: [] };
  // 已有报价页够数就不再插 —— 否则把已算好的页序再喂回来会多出报价页。
  const have = pages.reduce((n, p) => (n + p.type === 'quote' ? 1 : n), 0);
  if (have >= need) return { pages, insertedAt: [] };
  // 插在预算页之前；没有预算页（少见）就放末尾
  const budgetAt = pages.findIndex((p) => p.type === 'budget');
  const at = budgetAt >= 0 ? budgetAt : pages.length;
  const next = [...pages];
  const insertedAt: number[] = [];
  for (let k = have; k < need; k += 1) {
    next.splice(at + (k - have), 0, {
      ...QUOTE_PAGE,
      heading: k === 0 ? QUOTE_PAGE.heading : '设备清单与报价（续）',
      subtitle: `第 ${k + 1} / ${need} 页 · 共 ${summary?.kindCount ?? 0} 种设备 · ${summary?.deviceCount ?? 0} 台`,
    });
    insertedAt.push(at + (k - have));
  }
  return { pages: next, insertedAt };
}

/**
 * 交付页序列的输入：只要「有没有户型图」「有多少点位」「用哪套模版」三件事。
 * PPTX、讲稿、分享页都从这里取页序。
 */
export interface DeliveryPlanLike extends PointCountLike {
  pages: PlanPage[];
  floorplanUrl?: string | null;
  renderedFloorplanUrl?: string | null;
  quoteSummary?: QuoteSummary | null;
}

/**
 * 点位清单条数的判据只需要「有多少点位」「用哪套模版」——
 * 单独拆出来是因为渲染侧（PlanSlide）拿不到 pages，
 * 硬塞一个 pages 进去只会逼调用方造假数据。
 */
export interface PointCountLike {
  layoutPoints?: unknown[] | null;
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
}

/**
 * 点位清单是否走「编号列表」版式。
 *
 * 判据只有一条：**图上有没有编号徽章**。
 * 徽章没有还列编号，客户按编号回图里找必然找不到 —— 那是交付事故。
 *
 * - render 模版只放效果图，不叠点位 → 没有徽章
 * - compare 模版左右对照，两张都不叠点位 → 也没有徽章
 *   （AI 效果图是模型重画的，点位坐标按客户原图标，叠上去必然错位，
 *    而点位图是施工交底的依据，位置错了比没有图更糟）
 *   这两种模版的点位信息靠右栏的品类汇总与「设备清单与报价」页给。
 * - icon 模版的标记上是产品图，编号无意义
 */
export function deliverPointCount(plan: PointCountLike): number {
  const tpl = floorplanTemplate(plan.floorplanTemplate);
  if (tpl === 'render' || tpl === 'compare') return 0;
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
  const fp = withFloorplanPage(
    plan.pages,
    Boolean(plan.floorplanUrl || plan.renderedFloorplanUrl),
    floorplanTemplate(plan.floorplanTemplate),
  );
  const fpIndex = fp.pages.findIndex((p) => p.type === 'floorplan');
  if (fpIndex < 0) return { pages: fp.pages, virtualAt: [] };
  const list = withPointListPages(fp.pages, fpIndex, deliverPointCount(plan));
  const quote = withQuotePages(list.pages, plan.quoteSummary);
  return {
    pages: quote.pages,
    virtualAt: [...fp.virtualAt, ...list.insertedAt, ...quote.insertedAt].sort((a, b) => a - b),
  };
}
