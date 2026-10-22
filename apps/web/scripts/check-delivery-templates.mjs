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
  floorplanListPageNo,
  deliverPages,
  deliverPointCount,
} = await import('../src/lib/planPages.ts');
const { FLOORPLAN_TEMPLATES, MARKER_TEMPLATES, floorplanTemplate, markerTemplate } =
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
check('deliverPointCount：无点位为 0', deliverPointCount({ pages: pages4, layoutPoints: null }) === 0);

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

console.log(`\n小计: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
