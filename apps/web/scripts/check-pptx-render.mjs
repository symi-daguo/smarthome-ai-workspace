/**
 * PPTX 前两页的**本机渲染自证**（零新增依赖）。
 *
 * 为什么要有这道闸门：
 * `check-pptx-shadow.mjs` 只在 XML 层看阴影参数合法 ——
 * 参数合法 ≠ PowerPoint / WPS 能正常打开并显示。
 * 实测踩过：pptxgenjs 原地改写共享阴影对象，导出的 XML 里出现
 * `blurRad="2.44e+95"`、`alpha="75000000000000000000"`，
 * 参数「看起来是数」，但解析失败 → 那一页的形状整块不显示。
 * 这种缺陷只有**真渲染**才看得见，XML 检查抓不到。
 *
 * 这道闸门做三件事：
 *   1. 用**生产代码路径**（exportPlanPptx）生成前两页 —— 不自己造 PPTX，
 *      否则测的是「另写的一份 PPTX」而不是客户拿到的那份；
 *   2. 用**本机真实渲染器**（LibreOffice → PDF → PNG）出图；
 *   3. 检查渲染出来的图**不是空白**（有非背景像素、有颜色分布）——
 *      整块不显示的页渲染出来就是一张白纸，光看「文件能打开」抓不到。
 *
 * 渲染器选择：
 *   - 首选 `soffice`（LibreOffice）：无界面、可脚本化、判读稳定；
 *   - 退路 `qlmanage`（macOS Quick Look）：系统自带，但要装 Quick Look 插件；
 *   - 都没有 → **明确跳过并说明**（不能假装通过，也不能在没有渲染器时瞎断言）。
 *
 * 跑法：node apps/web/scripts/check-pptx-render.mjs
 */
import { registerHooks } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Vite 的 `?raw` 导入：把样式表当字符串读。
    // Node 不认这个后缀，得自己映射到真实文件并以文本形式导出 ——
    // theme/fonts.ts 要从 styles.css 里提取字体栈，给空模块会让它直接抛错。
    if (specifier.endsWith('?raw')) {
      const base = new URL(specifier.slice(0, -'?raw'.length), context.parentURL);
      for (const ext of ['.ts', '.tsx', '']) {
        const candidate = new URL(base.href + ext);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href + '?raw', context);
        }
      }
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of ['.ts', '.tsx']) {
        const candidate = new URL(base.href + ext);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    // `?raw`：模块内容就是文件文本（Vite 的语义）
    const raw = url.endsWith('?raw');
    const pathname = raw ? url.slice(0, -'?raw'.length) : url.split('?')[0].split('#')[0];
    if (raw) {
      return {
        format: 'module',
        source: `export default ${JSON.stringify(readFileSync(fileURLToPath(pathname), 'utf8'))};`,
        shortCircuit: true,
      };
    }
    // 裸 CSS 导入：给个空模块（渲染 PPTX 不需要样式表）
    if (pathname.endsWith('.css')) {
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const require = createRequire(import.meta.url);
const { exportPlanPptx } = await import('../src/lib/planPptx.ts');

let pass = 0;
let fail = 0;
let skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`); }
};
const skipCheck = (name, why) => { skip += 1; console.log(`SKIP ${name} —— ${why}`); };

const WORK = join(tmpdir(), `pptx-render-check-${process.pid}`);
mkdirSync(WORK, { recursive: true });

/**
 * 前两页用真实页型：封面 + 品牌/门店页。
 *
 * 为什么是这两页：封面与品牌页是**排版最复杂**的两页 ——
 * 封面有大图 + 叠加渐变 + 标题文字，品牌页有卡片阴影 + 多段文字。
 * 实测出问题的正是「形状整块不显示」，而这两页的形状最密。
 * 用真实的图片路径会让 fetch 失败（无服务器），但生产代码对取图失败是**容错**的
 * （返回空串、继续导出），所以这里用不存在的路径反而更接近「图片还没生成」的常见情形。
 */
const PAGES = [
  {
    type: 'cover',
    heading: '140㎡ 三室两厅全屋智能方案',
    subtitle: '把每天要用的，都变成不用想',
    body: '围绕三口之家的真实作息，把灯光、窗帘、暖通与安防连成一套会配合的系统。',
    bullets: ['全屋灯光：回家自动亮起', '窗帘电机：晨起自动开启', '安防联动：离家一键布防'],
    narration: '这份方案从您家的户型出发，讲清楚每一台设备装在哪、解决什么问题。',
    quote: '把钱花在每天用得上的地方',
  },
  {
    type: 'brand',
    heading: '门店服务与交付标准',
    subtitle: '从签约到入住，每一步都有标准',
    body: '我们按「现场勘测 → 方案确认 → 水电预留 → 设备安装 → 联调交付 → 售后回访」六步执行。',
    bullets: ['现场勘测：点位逐个确认', '水电交底：出具标注图', '安装调试：逐台通电测试'],
    narration: '这一页讲我们怎么交付，以及您会拿到什么。',
    quote: '交付有标准，售后有承诺',
  },
];

const plan = {
  title: '140㎡ 三室两厅全屋智能方案',
  customer: '王先生',
  area: '140㎡',
  store: 'SYMI 智能家居门店',
  style: 'warm',
  edition: '标准版',
  versionNo: 1,
  pages: PAGES,
  floorplanUrl: null,
  renderedFloorplanUrl: null,
  layoutPoints: null,
};

/** 找可用的渲染器 */
function findRenderer() {
  for (const [cmd, args] of [['soffice', ['--version']], ['qlmanage', ['-h']]]) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 20000 });
      return cmd;
    } catch { /* 试下一个 */ }
  }
  return null;
}

const renderer = findRenderer();
if (!renderer) {
  skipCheck('前两页本机渲染自证', '本机没有 LibreOffice(soffice) 也没有 qlmanage，无法做真实渲染');
  console.log('\n渲染器缺失：这项自证无法在本机完成，不算通过。');
  rmSync(WORK, { recursive: true, force: true });
  process.exit(2);
}
console.log(`渲染器：${renderer}`);

// —— 1. 用生产代码生成前两页 ——
const { blob, fileName } = await exportPlanPptx(plan);
// 落盘用**纯 ASCII 简单文件名**。
//
// 为什么不用生产导出的那个中文名：
// 实测 LibreOffice 遇到文件名含中文/空格/特殊字符（㎡）时直接
// 「Error: source file could not be loaded」，什么都渲染不出来。
// 那是渲染器的加载器对非 ASCII 路径的处理问题，不是 PPTX 内容有问题
// （同一个文件改成 simple.pptx 就能正常渲染）—— 但正好说明一件事：
// **导出文件名带中文与 ㎡ 时，某些工具链会读不了**。
// 所以这里用简单名渲染（保证测的是内容），
// 同时把「导出文件名」这件事本身作为一条独立断言记下来。
const pptxPath = join(WORK, 'render-check.pptx');
const buf = Buffer.from(await blob.arrayBuffer());
writeFileSync(pptxPath, buf);
check('生产代码路径（exportPlanPptx）产出了 PPTX', statSync(pptxPath).size > 5000, `${statSync(pptxPath).size} 字节`);

// 导出文件名本身要能被各平台工具链读：不能带路径分隔符等非法字符
const exportedName = fileName;
check(
  `导出文件名可用（${exportedName}）`,
  !/[\\/:*?"<>|]/.test(exportedName) && exportedName.endsWith('.pptx'),
);

// —— 2. 真实渲染 ——
const outDir = join(WORK, 'render');
mkdirSync(outDir, { recursive: true });
let rendered = [];
if (renderer === 'soffice') {
  // LibreOffice：pptx → pdf → png（pdf 再转图要 pdftoppm，缺了就先只到 pdf）
  execFileSync('soffice', [
    '--headless', '--norestore',
    '-env:UserInstallation=file://' + join(WORK, 'lo-profile'),
    '--convert-to', 'pdf', '--outdir', outDir, pptxPath,
  ], { stdio: 'ignore', timeout: 180000 });
  const pdf = join(outDir, 'render-check.pdf');
  check('LibreOffice 能把 PPTX 渲染成 PDF（打开不报错、不是空文件）',
    existsSync(pdf) && statSync(pdf).size > 10000,
    existsSync(pdf) ? `${statSync(pdf).size} 字节` : '没生成 PDF');
  // PDF → PNG：pdftoppm(poppler)
  const pngs = [];
  try {
    execFileSync('pdftoppm', ['-png', '-r', '96', '-f', '1', '-l', '2', pdf, join(outDir, 'page')],
      { stdio: 'ignore', timeout: 120000 });
    for (const f of ['page-1.png', 'page-2.png']) {
      const p = join(outDir, f);
      if (existsSync(p)) pngs.push(p);
    }
  } catch { /* 没有 pdftoppm 就只验 PDF */ }
  rendered = pngs;
} else {
  // qlmanage：直接给 pptx 出缩略图
  execFileSync('qlmanage', ['-t', '-s', '1600', '-o', outDir, pptxPath],
    { stdio: 'ignore', timeout: 120000 });
  const thumb = join(outDir, 'render-check.pptx.png');
  if (existsSync(thumb)) rendered = [thumb];
  check('Quick Look 能渲染 PPTX 预览图', rendered.length > 0);
}

check('渲染器产出了图像', rendered.length > 0, `产出 ${rendered.length} 张`);

// —— 3. 渲染结果非空白 ——
// 判据落在**像素**上：整块不显示的页渲染出来就是一张接近纯色的图。
// 数「与左上角背景色不同的像素占比」：空白页 ≈ 0，正常排版页有明显差异。
function inkRatio(pngPath) {
  // 不引入图像库：直接看 PNG 里 IDAT 解压后的字节里有多少非背景字节不现实，
  // 改用 macOS 自带的 sips 取尺寸 + 用 ImageMagick/ffmpeg 之类也不一定在。
  // 最省事且可靠的办法：转成 BMP 读像素（BMP 无压缩）。
  const bmp = join(WORK, 'probe.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', pngPath, '--out', bmp],
    { stdio: 'ignore', timeout: 60000 });
  const b = readFileSync(bmp);
  const headerSize = b.readUInt32LE(14);
  const width = b.readInt32LE(18);
  const height = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28);
  const bytes = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  // 取左上角 16x16 区域当背景色
  const sample = (x, y) => {
    const off = headerSize + y * rowSize + x * bytes;
    return [b[off + 2], b[off + 1], b[off]]; // BGR
  };
  const bg = sample(2, 2);
  let diff = 0;
  let total = 0;
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 200));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const [r, g, bl] = sample(x, y);
      total += 1;
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(bl - bg[2]) > 30) diff += 1;
    }
  }
  return { ratio: total ? diff / total : 0, width, height };
}

for (const p of rendered) {
  const name = p.split('/').pop();
  try {
    const { ratio, width, height } = inkRatio(p);
    check(
      `渲染图 ${name} 不是空白页（有内容的像素占比 ${(ratio * 100).toFixed(1)}%，${width}x${height}）`,
      ratio > 0.01 && width > 100 && height > 100,
      `占比 ${(ratio * 100).toFixed(2)}%`,
    );
  } catch (e) {
    check(`渲染图 ${name} 可读像素`, false, e instanceof Error ? e.message : String(e));
  }
}

console.log(
  fail === 0
    ? `\n全部通过（${pass} 项${skip ? `，跳过 ${skip} 项` : ''}）`
    : `\n有 ${fail} 项失败（共 ${pass + fail} 项）`,
);
console.log(`渲染产物目录：${WORK}`);
rmSync(WORK, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
