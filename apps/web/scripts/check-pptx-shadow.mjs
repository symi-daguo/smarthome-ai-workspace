/**
 * PPTX 阴影参数的自检（Node 原生类型剥离，零新增依赖）。
 *
 * 锁的是一个实测踩过的坑：
 * pptxgenjs 4.0.1 在生成**文字**阴影的 XML 时会**原地改写**传入的 shadow 对象
 * （把 pt 换算成 EMU、把 opacity 换算成 alpha）。
 * 如果 shadow 被定义成模块级共享常量再到处复用，每用一次就被再换算一次，
 * 几十次之后导出的 XML 里就是 `blurRad="2.44e+95"`、`alpha="75000000000000000000"` 这种数，
 * PowerPoint / WPS 解析失败 → 那一页的形状整块不显示。
 *
 * 跑法：node apps/web/scripts/check-pptx-shadow.mjs
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const { cardShadow, cardShadowSoft, shadowParamsSafe } = await import('../src/lib/planShadow.ts');
const require = createRequire(import.meta.url);
const PptxGenJS = (await import(require.resolve('pptxgenjs'))).default;
// jszip 是 pptxgenjs 自己的依赖，借它解压校验，不新增任何依赖。
// 解析基准取 pptxgenjs 所在目录 —— pnpm 的隔离布局下，依赖装在它旁边的 .pnpm 条目里。
const pptxgenDir = dirname(require.resolve('pptxgenjs'));
const JSZip = (await import(require.resolve('jszip', { paths: [pptxgenDir] }))).default;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`); }
};

/** 生成一份贴近真实用法的最小 PPTX：多个形状 + 多个文字，都带阴影 */
async function buildPptx(shadowFactory) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'WIDE';
  for (let p = 0; p < 3; p += 1) {
    const slide = pptx.addSlide();
    for (let i = 0; i < 6; i += 1) {
      slide.addShape('roundRect', {
        x: 0.5 + i, y: 1 + i * 0.4, w: 2.4, h: 1.2,
        fill: { color: 'FFFDFB' }, line: { color: 'F3EBE4', width: 0.5 }, rectRadius: 0.08,
        shadow: shadowFactory(),
      });
      slide.addText('要点文字', { x: 0.5 + i, y: 3, w: 2.4, h: 0.4, shadow: shadowFactory() });
    }
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

/** 取出所有阴影参数，判是否在合法范围内 */
function shadowParamsOf(xml) {
  const out = [];
  for (const m of xml.matchAll(/<a:(?:outer|inner)Shdw\b[^>]*>/g)) {
    const tag = m[0];
    const num = (n) => {
      const r = new RegExp(`${n}="([^"]*)"`).exec(tag);
      return r ? r[1] : '';
    };
    const alphaBlock = /<a:alpha val="([^"]*)"/.exec(xml.slice(m.index, m.index + 400));
    out.push({ blurRad: num('blurRad'), dist: num('dist'), dir: num('dir'), alpha: alphaBlock ? alphaBlock[1] : '' });
  }
  return out;
}

const legal = (v, max) => {
  const n = Number(v);
  return v !== '' && Number.isFinite(n) && n >= 0 && n <= max;
};

// —— 1. 共享常量会被 pptxgenjs 原地污染（这条是「测试确实能抓住这个坑」的证据）——
const SHARED = { type: 'outer', color: '1E160E', blur: 10, offset: 3, angle: 90, opacity: 0.16 };
await buildPptx(() => SHARED);
check(
  '共享常量确实会被 pptxgenjs 原地改写（这正是必须用工厂函数的原因）',
  !shadowParamsSafe(SHARED),
  `污染后 opacity=${SHARED.opacity} blur=${SHARED.blur}`,
);

// —— 2. 工厂函数：生成后定义对象仍然干净 ——
const probe = cardShadow();
await buildPptx(cardShadow);
check('工厂函数返回的对象在生成后未被污染', shadowParamsSafe(probe), `opacity=${probe.opacity} blur=${probe.blur}`);
check('工厂函数每次返回新对象（不是同一个引用）', cardShadow() !== cardShadow());
check('软阴影同样是新对象', cardShadowSoft() !== cardShadowSoft());

// —— 3. 真正产出的 XML 里，阴影参数必须全部合法 ——
const buf = await buildPptx(cardShadow);
const zip = await JSZip.loadAsync(buf);
const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
check('生成的 PPTX 里有幻灯片', slideNames.length > 0, `共 ${slideNames.length} 页`);
let bad = 0;
let total = 0;
for (const name of slideNames) {
  const xml = await zip.file(name).async('string');
  for (const p of shadowParamsOf(xml)) {
    total += 1;
    if (!legal(p.blurRad, 2_550_000) || !legal(p.dist, 2_550_000) || !legal(p.dir, 21_600_000) || !legal(p.alpha, 100000)) {
      bad += 1;
      if (bad <= 3) console.log(`      异常：${name} blurRad=${p.blurRad} dist=${p.dist} dir=${p.dir} alpha=${p.alpha}`);
    }
  }
}
check('所有阴影参数都在合法范围内', bad === 0, `共 ${total} 处阴影，异常 ${bad} 处`);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n有 ${fail} 项失败（共 ${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
