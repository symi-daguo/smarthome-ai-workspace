/**
 * 交付模版的纯逻辑回归检查（Node 原生类型剥离，零新增依赖）。
 *
 * 覆盖的是「交付件完整性」里最容易悄悄坏掉、且坏了客户才会发现的部分：
 * 点位清单**不能被截断**。点位表是施工交底的依据，少列一台设备等于那台设备装不装没定；
 * 而「看起来完整但少列了几台」比明显缺页更危险 —— 客户不会去数，只会照着单子签字。
 *
 * 跑法：node apps/web/scripts/check-delivery-templates.mjs
 */
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Node 的 ESM 解析要求完整扩展名，而项目源码按 Vite/TS 惯例写无扩展名相对导入。
 * 这里补一个解析钩子把 `../data/planTemplates` 映射到 `.ts`，
 * 源码里因此不必为了跑脚本而改成 `.ts` 后缀（TS 默认不允许该写法）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of ['.ts', '.tsx']) {
        const candidate = new URL(base.href + ext);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  POINT_ROWS_PER_PAGE,
  pointListPageCount,
  withPointListPages,
  withFloorplanPage,
  floorplanListPageNo,
  deliverPages,
  deliverPointCount,
} = await import('../src/lib/planPages.ts');
const { FLOORPLAN_TEMPLATES, MARKER_TEMPLATES, floorplanTemplate, markerTemplate, floorplanImages, floorplanPageCopy, COMPARE_LEFT_LABEL } =
  await import('../src/data/planTemplates.ts');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`); }
};

const fpPage = { type: 'floorplan', heading: '户型与设备点位', subtitle: '', body: '', bullets: [], narration: '' };
const cover = { type: 'cover', heading: '封面', subtitle: '', body: '', bullets: [], narration: '' };
const base = [cover, fpPage];

// —— 1. 清单页数：0 台不产续页，1..9 一页，10 起两页 ——
check('0 个点位 → 1 页清单', pointListPageCount(0) === 1);
check('9 个点位 → 1 页清单', pointListPageCount(9) === 1);
check('10 个点位 → 2 页清单', pointListPageCount(10) === 2);
check('12 个点位 → 2 页清单', pointListPageCount(12) === 2);
check('18 个点位 → 2 页清单', pointListPageCount(18) === 2);
check('19 个点位 → 3 页清单', pointListPageCount(19) === 3);

// —— 2. 续页插入：位置紧跟户型页，文案标明续与总台数 ——
const p12 = withPointListPages(base, 1, 12).pages;
check('12 个点位 → 插入 1 张续页', p12.length === 3);
check('续页紧跟在户型页之后', p12[2]?.type === 'floorplan');
check('续页标题标「续」', String(p12[2]?.heading ?? '').includes('续'));
check('续页标明总台数', String(p12[2]?.subtitle ?? '').includes('共 12 台设备'));
check('续页不重复画引言（quote 清空）', p12[2]?.quote === undefined);
check('不超页容量时不插续页', withPointListPages(base, 1, 9).pages.length === 2);
check('无户型页时不插续页', withPointListPages([cover], 0, 20).pages.length === 1);
check('户型页下标非法时不插续页', withPointListPages(base, -1, 20).pages.length === 2);
check('19 个点位插 2 张续页', withPointListPages(base, 1, 19).pages.length === 4);

// —— 3. 页序定位：续页在整份 PPT 里是第几张清单页 ——
const p19 = withPointListPages(base, 1, 19).pages;
check('首页是第 0 张清单页', floorplanListPageNo(p19, 1) === 0);
check('第 1 张续页是第 1 张清单页', floorplanListPageNo(p19, 2) === 1);
check('第 2 张续页是第 2 张清单页', floorplanListPageNo(p19, 3) === 2);
check('非户型页不参与计数', floorplanListPageNo([cover, cover], 1) === 0);

// —— 4. 模版取值：非法值必须回退默认，不能把垃圾值当模版用 ——
check('非法户型模版回退 annotated', floorplanTemplate('nope') === 'annotated');
check('空值回退 annotated', floorplanTemplate(null) === 'annotated');
check('合法户型模版原样返回', floorplanTemplate('compare') === 'compare');
check('非法放置模版回退 numbered', markerTemplate('nope') === 'numbered');
check('合法放置模版原样返回', markerTemplate('dot') === 'dot');
check('户型模版共 3 套', FLOORPLAN_TEMPLATES.length === 3);
check('放置模版共 3 套', MARKER_TEMPLATES.length === 3);
check('模版 key 互不重复', new Set(FLOORPLAN_TEMPLATES.map((t) => t.key)).size === 3);
check('每套模版都有说明与选择依据', FLOORPLAN_TEMPLATES.every((t) => t.name && t.desc && t.hint)
  && MARKER_TEMPLATES.every((t) => t.name && t.desc && t.hint));

// —— 5. 关键不变式：清单页容量与实际排版一致 ——
check(`每页清单容量 = ${POINT_ROWS_PER_PAGE} 行（与 PPTX 排版常量一致）`, POINT_ROWS_PER_PAGE === 9);

// —— 6. 页序唯一来源：deliverPages 是 PPTX / 讲稿 / 分享页共用的那一份 ——
// 这里守住两条：① 该插的续页一定插上 ② 不该插的绝不插
const pages4 = [cover, { type: 'layout', heading: '空间动线', subtitle: '', body: '', bullets: [], narration: '' }, { type: 'needs', heading: '需求', subtitle: '', body: '', bullets: [], narration: '' }];
const pts12 = Array.from({ length: 12 }, (_, i) => ({ name: `设备${i + 1}`, category: 'switch', x: 0.1, y: 0.1 }));

const dNoFp = deliverPages({ pages: pages4, layoutPoints: pts12 }).pages;
check('无户型图 → 不插户型页也不插续页', dNoFp.length === 3 && !dNoFp.some((p) => p.type === 'floorplan'));

const dFp = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12 }).pages;
check('有户型图 + 12 点位 → 插 1 户型页 + 1 续页', dFp.length === 5);
check('户型页排在 layout 页之后', dFp.findIndex((p) => p.type === 'floorplan') === 2);
check('续页紧跟户型页', dFp[3]?.type === 'floorplan' && String(dFp[3]?.subtitle ?? '').includes('共 12 台设备'));

const dFp9 = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12.slice(0, 9) }).pages;
check('有户型图 + 9 点位 → 只插 1 户型页', dFp9.length === 4);

const dIcon = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12, markerTemplate: 'icon' }).pages;
check('icon 放置模版 → 不出编号续页', dIcon.length === 4);

const dRender = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12, floorplanTemplate: 'render' }).pages;
check('render 户型模版 → 不出续页', dRender.length === 4);

const dBad = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12, floorplanTemplate: 'nope', markerTemplate: 'nope' }).pages;
check('非法模版回退默认 → 与显式默认同页序', dBad.length === dFp.length);

check('deliverPages 幂等（不会重复插页）', deliverPages({ pages: dFp, floorplanUrl: '/fp.png', layoutPoints: pts12 }).pages.length === 5);

check('deliverPointCount：numbered 按台数算', deliverPointCount({ pages: pages4, layoutPoints: pts12 }) === 12);
check('deliverPointCount：icon 模版不算编号清单', deliverPointCount({ pages: pages4, layoutPoints: pts12, markerTemplate: 'icon' }) === 0);
check('deliverPointCount：render 模版不算编号清单', deliverPointCount({ pages: pages4, layoutPoints: pts12, floorplanTemplate: 'render' }) === 0);
check('deliverPointCount：compare 模版不算编号清单（图上没有徽章）', deliverPointCount({ layoutPoints: pts12, floorplanTemplate: 'compare' }) === 0);
check('deliverPointCount：无点位为 0', deliverPointCount({ pages: pages4, layoutPoints: null }) === 0);

const dCompare = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12, floorplanTemplate: 'compare' }).pages;
check('compare 户型模版 → 不插编号清单续页', dCompare.length === 4);

// —— 7. 虚拟页映射：编辑时要把视图下标还原成真实页下标 ——
// 虚拟页（户型页 + 清单续页）没有文案，保存时绝不能当成真实页写进去。
const dFull = deliverPages({ pages: pages4, floorplanUrl: '/fp.png', layoutPoints: pts12 });
check('虚拟页下标已登记（户型页 + 1 张续页）', dFull.virtualAt.length === 2, JSON.stringify(dFull.virtualAt));
const toReal = (i) => i - dFull.virtualAt.filter((v) => v <= i).length;
check('虚拟页映射回真实页下标（户型页 → 上一真实页）', toReal(dFull.virtualAt[0]) === dFull.virtualAt[0] - 1);
check('续页映射回真实页下标（与户型页同一处）', toReal(dFull.virtualAt[1]) === dFull.virtualAt[0] - 1);
check('续页之后的真实页下标正确', toReal(dFull.virtualAt[1] + 1) === dFull.virtualAt[1] + 1 - 2);
check('无虚拟页时映射是恒等', deliverPages({ pages: pages4, layoutPoints: pts12 }).virtualAt.length === 0);

// —— 8. 图标尺寸与合成宽度：同一套口径，不许各处写死 ——
// 背景：一个产品有两种图 —— 门店自己拍的照片（object-fit: cover 铺满容器）
// 与系统自绘的品类图标（居中的小图）。以前缩略图是 40 容器放 20px（占 50%）、
// 点位标记是 26 容器放 16px（占 62%），同一列里一个有图一个没图，视觉大小差一截。
// 现在自绘图标统一占容器的 80%，且尺寸只允许从 ICON_SIZE 档位取。
//
// 另外 canvas 合成图此前三端各传各的宽度（分享页 1200 / PPTX 1400 / 导出 1600），
// 底图分辨率低时会合成出三张不同大小的图，标记像素跟着变 —— 统一到 COMPOSITE_WIDTH。
const iconSrc = readFileSync(join(WEB_SRC, 'lib/product-icons.ts'), 'utf8');
const overlaySrc = readFileSync(join(WEB_SRC, 'lib/pointOverlay.ts'), 'utf8');

const iconSizeBlock = iconSrc.match(/export const ICON_SIZE\s*=\s*\{([\s\S]*?)\}\s*as const;/);
check('ICON_SIZE 档位表存在', !!iconSizeBlock);
const sizeOf = (key) => {
  const m = iconSizeBlock?.[1].match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
  return m ? Number(m[1]) : NaN;
};
for (const key of ['inline', 'medium', 'thumb', 'marker', 'markerActive']) {
  check(`ICON_SIZE.${key} 有值`, Number.isFinite(sizeOf(key)), String(sizeOf(key)));
}
// 80% 口径：缩略图 40 盒、点位标记 26 / 32 圆
check('ICON_SIZE.thumb = 40 容器的 80%', sizeOf('thumb') === 32, String(sizeOf('thumb')));
check('ICON_SIZE.marker = 26 圆的 80%', sizeOf('marker') === 21, String(sizeOf('marker')));
check('ICON_SIZE.markerActive = 32 圆的 80%', sizeOf('markerActive') === 26, String(sizeOf('markerActive')));

// 所有图标调用点都不许写死数字（此前只扫两个文件，canvas / PPTX / 分享页全在盲区里）
const iconCallFiles = [
  'lib/product-icons.ts',
  'lib/pointOverlay.ts',
  'lib/planPptx.ts',
  'components/PlanSlide.tsx',
  'pages/ProductCenter.tsx',
  'pages/DeviceLayout.tsx',
];
const straySizes = [];
for (const rel of iconCallFiles) {
  const src = readFileSync(join(WEB_SRC, rel), 'utf8');
  for (const m of src.matchAll(/(?:productIconSvg|categoryIconSvg|iconSvgByKey)\([^)]*?,\s*(\d+)\s*,/g)) {
    straySizes.push(`${rel}:${m[1]}`);
  }
}
check(`图标调用点不再写死尺寸（发现 ${straySizes.length} 处）`, straySizes.length === 0, straySizes.join(' '));

// 合成宽度：三端必须用同一个常量
check('COMPOSITE_WIDTH 有定义', /export const COMPOSITE_WIDTH\s*=\s*\d+/.test(overlaySrc));
for (const fn of ['compositePoints', 'compositeHeatmap', 'compositeLightPlan']) {
  const m = overlaySrc.match(new RegExp(`export async function ${fn}\\([^)]*targetW\\s*=\\s*([A-Za-z_0-9]+)`));
  check(`${fn} 默认宽度取自 COMPOSITE_WIDTH`, m?.[1] === 'COMPOSITE_WIDTH', m?.[1] ?? '未匹配');
}
for (const rel of ['lib/planPptx.ts', 'components/PlanSlide.tsx', 'pages/DeviceLayout.tsx']) {
  const src = readFileSync(join(WEB_SRC, rel), 'utf8');
  const literal = src.match(/composite(?:Points|Heatmap|LightPlan)\([^)]*?,\s*(\d{3,5})\s*,/);
  check(`${rel} 调用合成时不传字面量宽度`, !literal, literal?.[1] ?? '');
}

// —— 9. 户型图口径唯一来源：floorplanImages（PPTX 与预览共用同一份）——
// 背景：compare 模版此前在 PPTX 与前端各写一遍内联口径，两边跑偏 ——
// 实测导出的 PPT 右栏画的是客户原图（不是 AI 精装修效果图），
// 标签却写着「AI 精装修效果 · 点位同步」，两处都在撒谎：
// 客户拿到的是「原图 vs 原图+点位」，模版承诺的改造前后对照根本没兑现。
const ORIG = '/fp.png';
const REND = '/render.png';
const pts3 = [{ name: '客厅灯', category: 'light', x: 0.2, y: 0.3 }];

const imAnn = floorplanImages({ floorplanUrl: ORIG, renderedFloorplanUrl: REND, floorplanTemplate: 'annotated', layoutPoints: pts3 });
check('annotated：主图是客户原图', imAnn.main === ORIG, String(imAnn.main));
check('annotated：叠点位', imAnn.overlayPoints === true);
check('annotated：标签写明是设备点位图', imAnn.mainLabel.includes('设备点位'), imAnn.mainLabel);

const imCmp = floorplanImages({ floorplanUrl: ORIG, renderedFloorplanUrl: REND, floorplanTemplate: 'compare', layoutPoints: pts3 });
check('compare：左栏是客户原图', imCmp.compareLeft === ORIG, String(imCmp.compareLeft));
check('compare：右栏是 AI 精装修效果图', imCmp.compareRight === REND, String(imCmp.compareRight));
check('compare：主图仍是客户原图', imCmp.main === ORIG, String(imCmp.main));
check('compare：两张都不叠点位', imCmp.overlayPoints === false);
check('compare：右栏标签如实', imCmp.compareRightLabel === 'AI 精装修效果图', imCmp.compareRightLabel);

const imCmpNoRender = floorplanImages({ floorplanUrl: ORIG, floorplanTemplate: 'compare', layoutPoints: pts3 });
check('compare：没有效果图时右栏回落原图', imCmpNoRender.compareRight === ORIG);
check('compare：没有效果图时标签说实话', imCmpNoRender.compareRightLabel.includes('暂无'), imCmpNoRender.compareRightLabel);

const imRen = floorplanImages({ floorplanUrl: ORIG, renderedFloorplanUrl: REND, floorplanTemplate: 'render', layoutPoints: pts3 });
check('render：主图是 AI 效果图', imRen.main === REND, String(imRen.main));
check('render：不叠点位', imRen.overlayPoints === false);
check('render：标签写明不含设备点位', imRen.mainLabel.includes('不含设备点位'), imRen.mainLabel);

check('没有户型图时主图为空', floorplanImages({ layoutPoints: pts3 }).main === null);

// 防跑偏闸门：两个渲染入口都必须走这份纯函数。
// 内联写法「原图 ?? 效果图」一旦重新出现，就说明有人绕过纯函数自己算图 ——
// 那正是本轮实测到的那类跑偏（两端口径不一致，且错的那份还在骗客户）。
const pptxSrc = readFileSync(join(WEB_SRC, 'lib/planPptx.ts'), 'utf8');
const slideSrc = readFileSync(join(WEB_SRC, 'components/PlanSlide.tsx'), 'utf8');
for (const [rel, src] of [['lib/planPptx.ts', pptxSrc], ['components/PlanSlide.tsx', slideSrc]]) {
  check(`${rel} 调用 floorplanImages（与另一端共用同一份口径）`, src.includes('floorplanImages('));
  check(`${rel} 不再内联「原图 ?? 效果图」口径`, !/floorplanUrl\s*\?\?\s*(?:plan\.)?renderedFloorplanUrl/.test(src));
  check(`${rel} 编号清单判定走 deliverPointCount`, src.includes('deliverPointCount('));
  check(`${rel} compare 左栏标签用同一份常量`, src.includes('COMPARE_LEFT_LABEL'));
}
check('COMPARE_LEFT_LABEL 文案已定稿', COMPARE_LEFT_LABEL === '原始户型（客户户型图）', COMPARE_LEFT_LABEL);

// —— 10. 户型页文案随模版变：图上没点位，文案就不许说点位 ——
// compare / render 的画面上没有编号徽章，沿用「把中控、面板…的落位逐一点出」
// 就是当着客户的面说图上有、图上却没有 —— 文案在撒谎。
const copyAnn = floorplanPageCopy('annotated');
const copyCmp = floorplanPageCopy('compare');
const copyRen = floorplanPageCopy('render');
check('annotated 页型标签是「户型与设备点位」', copyAnn.typeLabel === '户型与设备点位', copyAnn.typeLabel);
check('annotated 正文讲落位', copyAnn.body.includes('落位'));
check('compare 页型标签是「户型改造前后对照」', copyCmp.typeLabel === '户型改造前后对照', copyCmp.typeLabel);
check('compare 正文不讲「逐一点出落位」', !copyCmp.body.includes('逐一点出'), copyCmp.body);
check('compare 讲稿不讲「每个图标对应一台设备」', !copyCmp.narration.includes('每个图标'), copyCmp.narration);
check('render 页型标签是「智能精装效果示意」', copyRen.typeLabel === '智能精装效果示意', copyRen.typeLabel);
check('render 正文不讲落位', !copyRen.body.includes('落位'), copyRen.body);
check('三套文案互不相同', new Set([copyAnn.heading, copyCmp.heading, copyRen.heading]).size === 3);

// 插页时必须用对应模版的文案（户型页插在 layout 页之后）
const layoutPage = { type: 'layout', heading: '空间动线', subtitle: '', body: '', bullets: [], narration: '' };
const fpPagesCmp = withFloorplanPage([cover, layoutPage], true, 'compare').pages;
check('compare 插页用对照版文案', fpPagesCmp[2]?.heading === '户型改造前后对照', String(fpPagesCmp[2]?.heading));
const fpPagesAnn = withFloorplanPage([cover, layoutPage], true, 'annotated').pages;
check('annotated 插页用点位版文案', fpPagesAnn[2]?.heading === '户型与设备点位', String(fpPagesAnn[2]?.heading));
check('插页默认仍是点位版（老调用方不受影响）', withFloorplanPage([cover, layoutPage], true).pages[2]?.heading === '户型与设备点位');
check('compare 插页正文也不讲落位', !String(fpPagesCmp[2]?.body ?? '').includes('逐一点出'));

// 页型标签也要跟着变（PPTX 的 folio 与前端 Folio 共用这份）
for (const [rel, src] of [['lib/planPptx.ts', pptxSrc], ['components/PlanSlide.tsx', slideSrc]]) {
  check(`${rel} 页型标签走 floorplanPageCopy`, src.includes('floorplanPageCopy('));
}

// —— 11. 失败请求要真的被记下来 ——
// 反馈页有一处「N 个失败请求」的展示，但记录动作一度没有任何调用方，
// 于是那块 UI 永远是空的、上下文里承诺的「最近哪个请求失败」从来没兑现过。
// 现在记录挂在 lib/api.ts 的请求出口上（那是所有请求唯一的出口）。
// 判据落在源码上：api.ts 在 Node 里跑不起来（import.meta.env / localStorage），
// 行为级测试需要另起一套 shim，不值当。
const apiSrc = readFileSync(join(WEB_SRC, 'lib/api.ts'), 'utf8');
const errCtxSrc = readFileSync(join(WEB_SRC, 'lib/errorContext.ts'), 'utf8');
check('lib/api.ts 在请求失败时记一笔（网络错误与 HTTP 错误两条路径）',
  (apiSrc.match(/noteFailure\(/g) ?? []).length >= 3, // 1 处定义 + 2 处调用
);
check('失败请求只在已登录时记（未登录的失败与业务无关）',
  /const noteFailure = \(msg: string\): void => \{\s*if \(token\) recordFailedRequest\(path, msg\);/.test(apiSrc),
);
check('lib/errorContext.ts 仍导出 recordFailedRequest',
  /export function recordFailedRequest\(/.test(errCtxSrc),
);
// api.ts 现在 import errorContext.ts；errorContext.ts 若再 import api.ts 就是循环依赖，
// 运行期会拿到未初始化的模块引用，报错还很难定位。
check('lib/errorContext.ts 不再 import lib/api.ts（防循环依赖）',
  !/from '\.\/api'/.test(errCtxSrc),
);

// —— 12. JSX 注释不能吞掉代码 ——
// JSX 注释是 `{/* ... */}`，遇到第一个 `*/` 就结束。
// 当同一段代码被写成「外层 {/* + 代码 + 残留的 {/* + 同样一份代码 + */}」时，
// 内层 `{/*` 没有自己的闭合，外层末尾的 `*/}` 会把**两份代码一起**注释掉 ——
// 按钮在界面上根本不出现，而编译器完全沉默（被注释掉的代码不是语法错误，typecheck 查不出来）。
//
// 真实后果：1.0.4 放回的一批生成入口（生成图片 / 反推提示词 / 一键生成标题与卖点 /
// 生成视频 / AI 解析建档 / AI 跟进建议 / AI 批量处理 / 生成方案文案 /
// 生成灯光场景视频 / 生成灯光建议 / 我的额度 / /quota 路由）在 1.0.4 之后一直是隐藏的 ——
// 页面文案写着「选好提示词后点『生成图片』」，但页面上根本没有那个按钮。
//
// 判据落源码，两条：
// ① 全仓库不存在「注释块内再写 {/*」的嵌套注释
// ② 关键入口在**去掉注释之后的代码**里 —— 只查「文件里有没有这个字符串」不够，
//    因为被注释掉的字符串照样能被 grep 到
const readdirSync2 = (await import('node:fs')).readdirSync;

/** 找出所有「注释块内又出现 {/*」的嵌套注释块（这类块会把代码整段吞掉） */
function findNestedCommentBlocks(src) {
  const hits = [];
  let pos = 0;
  for (;;) {
    const s = src.indexOf('{/*', pos);
    if (s === -1) break;
    const e = src.indexOf('*/}', s + 3);
    if (e === -1) break;
    if (src.slice(s + 3, e + 3).includes('{/*')) {
      hits.push(src.slice(0, s).split('\n').length);
    }
    pos = s + 3;
  }
  return hits;
}

/** 去掉 JSX 注释块，得到「真正会渲染/生效的代码」 */
const stripJsxComments = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const tsxFiles = [];
const collectTsx = (dir) => {
  for (const entry of readdirSync2(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(p);
    else if (entry.name.endsWith('.tsx')) tsxFiles.push(p);
  }
};
collectTsx(WEB_SRC);

const nestedHits = [];
const effectiveByFile = new Map();
for (const f of tsxFiles) {
  const src = readFileSync(f, 'utf8');
  const hits = findNestedCommentBlocks(src);
  for (const line of hits) nestedHits.push(`${f.replace(WEB_SRC + '/', '')}:${line}`);
  effectiveByFile.set(f, stripJsxComments(src));
}
check('没有「JSX 注释块内再写 {/*」的嵌套注释（这类块会把代码整段吞掉）',
  nestedHits.length === 0,
  nestedHits.join('、'),
);

// 闸门本身要能证伪：拿一段含嵌套注释的样本喂给检测逻辑，必须报出来
check('嵌套注释检测能抓到样本（闸门自身可证伪）',
  findNestedCommentBlocks('{\/*\n<Button />\n{/*\n<Button />\n*\/}').length === 1,
);
check('去注释逻辑能剔掉注释块里的内容（否则第 ② 条断言会假通过）',
  !stripJsxComments('{/* 生成图片 */}').includes('生成图片'),
);

// ② 关键入口必须在「去掉注释之后」的代码里
// 这张表是「入口不许被注释块吞掉」的守门人 —— 注释掉的按钮在界面上等于没有，
// 而代码里还看得见，只靠肉眼发现不了。
// 注意：删掉一个入口时，要**同时**从这里删掉对应行 ——
// 否则这条断言会一直要求那个入口存在，等于用检查脚本把已废弃的功能钉死。
const REQUIRED_ENTRIES = [
  ['App.tsx', 'path="quota"', '额度说明页 /quota 路由'],
  ['pages/ImageStudio.tsx', '生成图片', 'AI 生图「生成图片」'],
  ['pages/ImageStudio.tsx', '反推提示词', 'AI 生图「反推提示词」'],
  ['pages/ImageStudio.tsx', '一键生成标题与卖点', 'AI 生图「一键生成标题与卖点」'],
  ['pages/VideoStudio.tsx', '生成视频', 'AI 生视频「生成视频」'],
  ['pages/OrderStudio.tsx', 'AI 解析建档', '接单「AI 解析建档」'],
  ['pages/OrderStudio.tsx', 'AI 跟进建议', '接单「AI 跟进建议」'],
  ['pages/ProductCenter.tsx', 'AI 批量处理', '产品中心「AI 批量处理」'],
  ['pages/PlanStudio.tsx', '生成方案文案', '智能方案「生成方案文案」'],
  ['pages/LightingStudio.tsx', '生成灯光场景视频', '灯光场景「生成灯光场景视频」'],
  ['pages/LightingDiagnosis.tsx', '生成灯光建议', '灯光诊断「生成灯光建议」'],
  ['pages/TokenCenter.tsx', '我的额度', '个人中心「我的额度」卡片'],
  ['layouts/MainLayout.tsx', '开源说明', '顶栏「开源说明」按钮'],
];
const missingEntries = REQUIRED_ENTRIES
  .filter(([rel, needle]) => !(effectiveByFile.get(join(WEB_SRC, rel)) ?? '').includes(needle))
  .map(([rel, , label]) => `${label}（${rel}）`);
check('关键入口都在生效代码里（不在注释块内）',
  missingEntries.length === 0,
  missingEntries.join('、'),
);

// —— 13. 说明页的数字不许手写 ——
// 额度说明页要报「N 个预置智能体」「N 个工具入口」这两个数。
// 手写过一次：说明页写「智能百宝箱 20 个工具入口」，实际清单里是 21 个 ——
// 唯一来源是 TreasureBox 的 GROUPS，改一个加一个，说明页不跟着变就漂了。
// 现在两个数字都从各自清单自动算，说明页里不再出现手写数字。
const quotaSrc = readFileSync(join(WEB_SRC, 'pages/Quota.tsx'), 'utf8');
const treasureSrc = readFileSync(join(WEB_SRC, 'pages/TreasureBox.tsx'), 'utf8');
const { PRESET_AGENT_COUNT } = await import('../src/data/agents.ts');

check('额度说明页不再手写「N 个预置智能体」（数字取自 agents.ts）',
  !/\d+ 个预置智能体/.test(quotaSrc) && quotaSrc.includes('PRESET_AGENT_COUNT'),
);
check('额度说明页不再手写「N 个工具入口」（数字取自 TreasureBox 的清单）',
  !/\d+ 个工具入口/.test(quotaSrc) && quotaSrc.includes('TOOL_COUNT'),
);
check('预置智能体数是 12（不含「通用对话」那一个）',
  PRESET_AGENT_COUNT === 12,
  `实测 ${PRESET_AGENT_COUNT}`,
);
// 百宝箱清单是 .tsx（带 JSX 与组件依赖），Node 里 import 不了，按源码条目数统计。
const toolEntryCount = (treasureSrc.match(/\{ key: '[^']*', img: '\/images\/tools\//g) ?? []).length;
check('百宝箱工具入口数是 21（说明页会显示这个数）',
  toolEntryCount === 21,
  `实测 ${toolEntryCount}`,
);

// —— 14. 页型配图覆盖表：没配过就等于「什么都没变」 ——
// 门店可以为每个页型配自己的实景图（覆盖写死的 PAGE_IMAGE 常量）。
// 这里锁死最要紧的那条：**覆盖表为空时，取图结果逐字等于原来的常量** ——
// 没配过配图的部署必须与改动前完全一致，否则这次改动就是「让所有人丢图」。
const { PAGE_IMAGE, resolvePageImage, setPageImageOverrides, clearPageImageOverrides } =
  await import('../src/data/planThemes.ts');

const pageTypes = Object.keys(PAGE_IMAGE);
const pageOf = (type, extra = {}) => ({
  type, heading: '', subtitle: '', body: '', bullets: [], narration: '', ...extra,
});
clearPageImageOverrides();
// 场景页是例外：它原本就按副标题关键词细化配图（sceneImage），不是直接取 PAGE_IMAGE，
// 所以「等于常量」这条只对其余页型成立；场景页单独一条断言（见下）。
const constantTypes = pageTypes.filter((t) => t !== 'scene');
const fallbackMismatch = constantTypes.filter(
  (t) => resolvePageImage(pageOf(t)) !== PAGE_IMAGE[t],
);
check(
  '未配置页型配图时，取图结果逐字等于 PAGE_IMAGE 常量（没配 = 行为不变）',
  constantTypes.length > 0 && fallbackMismatch.length === 0,
  fallbackMismatch.join(' / '),
);
// 场景页原本按副标题关键词细化配图，覆盖表为空时这条口径不能丢
check(
  '未配置时场景页仍按关键词细化配图（sceneImage 口径没丢）',
  resolvePageImage(pageOf('scene', { subtitle: '主卧卧室起夜' })) === '/images/cases/c3.jpg'
    && resolvePageImage(pageOf('scene', { subtitle: '客厅家庭影院' })) === '/images/cases/c2.jpg',
);
setPageImageOverrides({ floorplan: '/api/media/assets/xxx/file' });
check(
  '配置了页型配图后取图用配置值',
  resolvePageImage(pageOf('floorplan')) === '/api/media/assets/xxx/file',
  resolvePageImage(pageOf('floorplan')),
);
check(
  '未配置的页型仍走常量（覆盖只影响配过的那个页型）',
  resolvePageImage(pageOf('cover')) === PAGE_IMAGE.cover,
);
setPageImageOverrides({ notAPageType: '/api/media/assets/yyy/file' });
check(
  '覆盖表忽略不存在的页型（服务端可能留着历史页型）',
  constantTypes.every((t) => resolvePageImage(pageOf(t)) === PAGE_IMAGE[t]),
);
clearPageImageOverrides();

// —— 15. 财务三模块：附加费 / 页数核算 / 额度换算 ——
// 这三个模块直接决定「客户看到的钱」：
// 附加费算错 → 报价单多收钱；页数算错 → 交付件少几页；
// 额度换算错 → 用户看到的余额与实际扣费对不上。
// 判据一律落在**算出来的数字**上，不看界面、不看文案。
const { feeAmount, feesTotal } = await import('../src/lib/quoteFees.ts');
const { CORE_MODULES, PAGE_COUNT_MAX, materialPageMinimum, resolvePageCount, estimateCost } =
  await import('../src/lib/pageBudget.ts');
const { tokenToYuan } = await import('../src/lib/money.ts');

const fee = (mode, amount) => ({ name: 'x', mode, amount });
const noMaterial = { floorplanCount: 1, renderCount: 0 };

check(
  '附加费：三种模式各按自己的口径计（none=0 / fixed=填写额 / percent=小计×百分比）',
  feeAmount(fee('none', 99999), 10000) === 0
    && feeAmount(fee('fixed', 200), 10000) === 200
    && feeAmount(fee('percent', 3), 10000) === 300,
);
check(
  '附加费：0% 费率计 0 元；负费率按原公式为负（不静默夹成 0，错配置要看得见）',
  feeAmount(fee('percent', 0), 10000) === 0
    && feeAmount(fee('percent', -10), 10000) === -1000,
);
check(
  '附加费：超大费率按原公式放大（1000000% × 1 元 = 10000 元，不做上限截断）',
  feeAmount(fee('percent', 1000000), 1) === 10000,
);
check(
  '附加费：合计等于逐项相加（空列表 0，单项等于该项，none 项不参与）',
  feesTotal([], 10000) === 0
    && feesTotal([fee('fixed', 200)], 10000) === 200
    && feesTotal([fee('fixed', 200), fee('percent', 3), fee('none', 999)], 10000) === 500,
);
check(
  `页数：NaN 兜底为沟通模块基数（${CORE_MODULES} 页）`,
  resolvePageCount(Number.NaN, noMaterial, 'standard') === CORE_MODULES,
);
check(
  `页数：低于下限夹到 ${CORE_MODULES}、高于上限夹到 ${PAGE_COUNT_MAX}`,
  resolvePageCount(3, noMaterial, 'standard') === CORE_MODULES
    && resolvePageCount(99, noMaterial, 'standard') === PAGE_COUNT_MAX,
);
check(
  '页数：素材下限高于所选页数时按素材下限算（9 + 2 张额外户型图 + 2 个素材页 = 13）',
  resolvePageCount(10, { floorplanCount: 3, renderCount: 2 }, 'standard') === 13,
);
check(
  '页数：私宅版至少留 1 页场景演示（10 页 vs 标准版 9 页）',
  materialPageMinimum(noMaterial, 'private') === 10
    && materialPageMinimum(noMaterial, 'standard') === CORE_MODULES,
);
check(
  '出图费用：四舍五入到分（9 页 medium 9.00 / high 14.40 / low 5.40，未知画质回落 medium）',
  estimateCost(9) === '9.00'
    && estimateCost(9, 'high') === '14.40'
    && estimateCost(9, 'low') === '5.40'
    && estimateCost(3, 'nope') === '3.00',
);
check(
  '额度换算：比例恒为 100 token = ¥1.00（占比归一，不因改动漂成别的比例）',
  tokenToYuan(100) === '¥1.00' && tokenToYuan(0) === '¥0.00',
);
/** 元 → 分（避免浮点误差，0.1 + 0.2 那种） */
const fen = (yuan) => Math.round(Number(yuan.replace('¥', '')) * 100);
check(
  '额度换算：整数 token 四舍五入到分不失真，逐笔换算合计 = 一次换算（不丢 1 分）',
  tokenToYuan(1) === '¥0.01'
    && fen(tokenToYuan(1)) * 3 === fen(tokenToYuan(3))
    && fen(tokenToYuan(123)) === 123,
);
// 预算分配建议：算式在纯 TS 模块 lib/budgetSplit.ts 里（.tsx 带 JSX，Node 里 import 不了），
// 所以这里能**直接调用**它断言，而不是在源码里正则扒数字。
//
// 为什么这条必须有：分摊算式曾写成 `budgetTotal * percent * 10 / 10` ——
// percent 是百分数（22 = 22%）却按 `* 10` 算，差 100 倍：
// 预算 13 万时「安防 22%」显示成 286 万，界面上的合计凭空多出 1700 万，
// 而且这个错值会落库、还会作为生成提示词的硬约束传给模型。
const { ECOSYSTEM_SPLIT, splitAmount, buildBudgetSplit } = await import('../src/lib/budgetSplit.ts');
const splitPercents = ECOSYSTEM_SPLIT.map((r) => r.percent);
check(
  '预算分配建议：各项占比合计 100%（比例写错，分摊总额就对不上）',
  splitPercents.length === 6 && splitPercents.reduce((a, b) => a + b, 0) === 100,
  splitPercents.join(' + '),
);
check(
  '预算分配建议：百分数按 /100 折算（预算 13 万 × 安防 22% = 2.9 万，不是 286 万）',
  splitAmount(22, null, 13) === 2.9,
  `实际 ${splitAmount(22, null, 13)}`,
);
check(
  '预算分配建议：六项分摊合计等于预算总额（0.1 万精度内）',
  Math.abs(
    Object.values(buildBudgetSplit({}, 13)).reduce((a, b) => a + b, 0) - 13,
  ) <= 0.1,
  Object.entries(buildBudgetSplit({}, 13)).map(([k, v]) => `${k}=${v}`).join(' '),
);
check(
  '预算分配建议：门店改过的金额优先于建议占比，且原样进入提交映射',
  splitAmount(22, 5.5, 13) === 5.5 && buildBudgetSplit({ security: 5.5 }, 13).安防 === 5.5,
);
check(
  '预算分配建议：没填预算时各项为 0（不是 NaN、也不是按 0 预算硬算）',
  splitAmount(22, null, null) === 0 && Object.values(buildBudgetSplit({}, null)).every((v) => v === 0),
);
check(
  '预算分配建议：提交映射的键是生态中文名（要直接进提示词、也要让 Agent 读得懂）',
  Object.keys(buildBudgetSplit({}, 13)).join(',') === '安防,灯光,遮阳,影音,暖通,网络',
);

// —— 16. 页型配图：预算页 / 报价页 / 其它页型都走同一套取图口径 ——
// 预算页与报价页的页眉横幅是这一轮加的（与 PPTX 侧 bannerPanel 同一位置语义）。
// 判据：① 取图口径仍收敛在 resolvePageImage 一处
// ② 预算页与报价页确实取得到横幅图 ③ 其它页型不受影响
// ④ 户型页依然没有配图落位（返回空串是正常情况，不是异常）
clearPageImageOverrides();
check(
  '页型配图：预算页与报价页都取得到横幅配图',
  resolvePageImage(pageOf('budget')) !== '' && resolvePageImage(pageOf('quote')) !== '',
);
check(
  '页型配图：其它页型取图结果仍等于 PAGE_IMAGE 常量（横幅改动没影响它们）',
  resolvePageImage(pageOf('cover')) === PAGE_IMAGE.cover
    && resolvePageImage(pageOf('needs')) === PAGE_IMAGE.needs
    && resolvePageImage(pageOf('delivery')) === PAGE_IMAGE.delivery,
);
check(
  '页型配图：户型页没有配图落位（返回空串是正常情况）',
  resolvePageImage(pageOf('floorplan')) === '',
);
check(
  '页型配图：PlanSlide 的预算页与报价页都接了顶部横幅（同一张图、同一位置语义）',
  (slideSrc.match(/<Banner\b/g) ?? []).length === 2
    && slideSrc.includes('Banner src={pageImage(page)}'),
);
check(
  '页型配图：PlanSlide 的配图一律走真正的 <img>（不再用 CSS 背景图承载）',
  slideSrc.includes('<img') && !/background:\s*`url\(/.test(slideSrc),
);
const printSrc = readFileSync(join(WEB_SRC, 'pages/PlanPrintView.tsx'), 'utf8');
check(
  '打印视图：打印前等图加载完，并带超时兜底（不会无限等）',
  printSrc.includes('PRINT_IMAGE_TIMEOUT_MS') && printSrc.includes('Promise.race'),
);

console.log(`\n小计: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);