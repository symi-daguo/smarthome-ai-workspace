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
): { pages: PlanPage[]; syntheticAt: number } {
  const ok = hasFloorplan && !pages.some((p) => p.type === 'floorplan');
  if (!ok) return { pages, syntheticAt: -1 };
  const at = pages.findIndex((p) => p.type === 'layout');
  const idx = at < 0 ? 3 : at + 1;
  const next = [...pages];
  next.splice(idx, 0, { ...FLOORPLAN_PAGE });
  return { pages: next, syntheticAt: idx };
}
