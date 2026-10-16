import PptxGenJS from 'pptxgenjs';
import { planTheme, PAGE_TYPE_LABEL, PAGE_IMAGE, sceneImage, type PlanPage } from '../data/planThemes';
import { catMeta, compositePoints } from './pointOverlay';
import { customerText } from './planSanitize';
import { withFloorplanPage } from './planPages';
import { downloadBlob } from './download';

/**
 * 方案 PPT 生成器（16:9 原生可编辑幻灯片）。
 * 设计系统分层（jingmei-ppt skill 方法论）：tokens=planThemes 角色色；
 * primitives=页眉/主张/阴影卡/配图/引言/页脚；compositions=8 类页型独立轮廓。
 * 相对"整页 PNG 拍平"式交付的优势：文本/图表/形状全部原生可编辑。
 */

export interface PlanForExport {
  title: string;
  customer: string;
  area: string;
  store: string;
  style: string;
  edition: string;
  versionNo: number;
  pages: PlanPage[];
  /** 点位编辑器挂接的户型底图（含 ?token= 的可加载 URL）与设备点位 */
  floorplanUrl?: string | null;
  /** AI 渲染的精装修效果图（与原始户型图共存时优先用此图，覆盖点位叠加） */
  renderedFloorplanUrl?: string | null;
  layoutPoints?: { name: string; category: string; iconKey?: string; x: number; y: number }[] | null;
}

// 16:9 = 13.333 x 7.5 英寸
const W = 13.333;
const H = 7.5;
const MX = 0.66; // 左右外边距
/** 户型页左栏图片框（英寸），与前端卡片的图片区保持同一比例 */
const FLOOR_BOX: [number, number] = [8.6, 6.15];
import { FONT_PPTX } from '../theme/fonts';
const FONT = FONT_PPTX;

/** 卡片阴影（pptxgenjs shadow：blur/offset 单位 pt，opacity 0-1） */
const SHADOW = { type: 'outer' as const, color: '1E160E', blur: 10, offset: 3, angle: 90, opacity: 0.16 };
const SHADOW_SOFT = { type: 'outer' as const, color: '1E160E', blur: 6, offset: 2, angle: 90, opacity: 0.1 };

/**
 * 取图片的 dataURL。
 *
 * 三个坑都在这里，缺一个就是「导出没反应」：
 * 1. 不检查 res.ok —— 401/404 的响应体也会被当图片读进去，pptxgenjs 写图时才炸，
 *    报错又发生在 await 链深处，界面上只看到「转圈然后没动静」
 * 2. fetch 不设超时 —— 一张图请求挂住，整个 Promise.all 永远不返回
 * 3. 失败静默吞掉 —— 排查时完全看不出是哪张图挂了
 */
async function imgData(path: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(path, { signal: ctl.signal });
    if (!res.ok) {
      console.warn('[pptx] 图片取不到', res.status, path);
      return '';
    }
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) {
      console.warn('[pptx] 响应不是图片', blob.type, path);
      return '';
    }
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('FileReader 失败'));
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('[pptx] 图片加载失败', (e as Error).message, path);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * pptxgenjs 浏览器版 sizing:cover 的已知缺陷：不读取原图 intrinsic 尺寸（srcRect 恒为 0），
 * 实际效果等同拉伸。用 canvas 预裁剪出与目标框同比例的图（center/焦点裁剪），再按原框 addImage。
 * focus: 'center' | 'right'（c4 类灯光偏右的图）
 */
async function coverCrop(dataUrl: string, ratioW: number, ratioH: number, focus: 'center' | 'right' = 'center'): Promise<string> {
  if (!dataUrl) return '';
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  }).catch(() => undefined);
  if (!img.naturalWidth) return dataUrl;
  const target = ratioW / ratioH;
  const src = img.naturalWidth / img.naturalHeight;
  let cw = img.naturalWidth;
  let ch = img.naturalHeight;
  if (src > target) cw = Math.round(img.naturalHeight * target);
  else ch = Math.round(img.naturalWidth / target);
  const cx = focus === 'right' ? img.naturalWidth - cw : Math.round((img.naturalWidth - cw) / 2);
  const cy = Math.round((img.naturalHeight - ch) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** 读取 dataURL 图片的宽高比（w/h） */
async function imageRatio(dataUrl: string): Promise<number> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });
  return img.naturalWidth / img.naturalHeight || 1;
}

function hex(c: string): string {
  return c.replace('#', '');
}

function lighten(c: string, f: number): string {
  const h = hex(c);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const m = (v: number): string => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0');
  return m(r) + m(g) + m(b);
}

interface BudgetItem { name: string; min: number; max: number; }

function parseBudget(bullets: string[]): BudgetItem[] | null {
  const items: BudgetItem[] = [];
  for (const b of bullets) {
    const m = b.match(/^(.+?)\s*[：:]\s*([\d,]+)\s*[-–~]\s*([\d,]+)/);
    if (!m) return null;
    const min = Number(m[2].replace(/,/g, ''));
    const max = Number(m[3].replace(/,/g, ''));
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
    items.push({ name: m[1].trim(), min, max });
  }
  return items.length >= 2 ? items : null;
}

function parseStages(bullets: string[]): { name: string; desc: string }[] | null {
  const stages = bullets.map((b) => {
    const cleaned = b.replace(/^\s*0?\d{1,2}\s*[.、::｜|]?\s*/, '');
    const idx = cleaned.search(/[｜|：:]/);
    if (idx < 0) return { name: cleaned.trim(), desc: '' };
    return { name: cleaned.slice(0, idx).trim(), desc: cleaned.slice(idx + 1).replace(/[｜|]/g, ' ').trim() };
  });
  const ok = stages.filter((s) => s.name && s.desc);
  return ok.length >= 3 ? ok.slice(0, 6) : null;
}

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : `${n}`;
}

function pageImageType(page: PlanPage): string {
  return page.type === 'scene' ? sceneImage(page.subtitle + page.heading) : PAGE_IMAGE[page.type];
}

type Theme = ReturnType<typeof planTheme>;

export async function exportPlanPptx(plan: PlanForExport): Promise<void> {
  const t = planTheme(plan.style);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: W, height: H });
  pptx.layout = 'WIDE';
  pptx.title = plan.title;
  pptx.author = plan.store || '智居 AI 工作台';

  // 预取全部页型配图（去重），并按各页实际图框比例 canvas 预裁剪（pptxgenjs cover 失效的规避）
  const IMG_BOX: Partial<Record<PlanPage['type'], [number, number]>> = {
    cover: [W * 0.42, H],
    brand: [3.1, H - 1.0],
    layout: [3.3, H - 1.0],
    needs: [W, 2.45],
    ecosystem: [3.4, 2.9],
    scene: [W * 0.34, H],
    delivery: [2.6, 2.45],
  };
  console.info('[pptx] 开始导出，原始页数', plan.pages.length, '标题', plan.title);
  const imgPaths = [...new Set(plan.pages.map(pageImageType))];
  console.info('[pptx] 待取图', imgPaths.length, '张');
  const rawMap = new Map<string, string>();
  await Promise.all(imgPaths.map(async (p) => rawMap.set(p, await imgData(p))));
  console.info('[pptx] 原图取齐');
  const cropMap = new Map<string, string>();
  await Promise.all(
    plan.pages.map(async (p) => {
      const key = `${pageImageType(p)}|${p.type}`;
      if (cropMap.has(key)) return;
      const [bw, bh] = IMG_BOX[p.type] ?? [16, 9];
      const focus = pageImageType(p).includes('/c4.') ? 'right' : 'center';
      cropMap.set(key, await coverCrop(rawMap.get(pageImageType(p)) ?? '', bw, bh, focus));
    }),
  );
  console.info('[pptx] 裁剪完成');
  const img = (page: PlanPage): string => cropMap.get(`${pageImageType(page)}|${page.type}`) ?? '';

  // 空间动线页：优先用精装修效果图 > 户型+点位合成图 > 场景实景图
  let floorplan: { data: string; ratio: number } | null = null;
  if (plan.renderedFloorplanUrl) {
    try {
      const data = await imgData(plan.renderedFloorplanUrl);
      floorplan = { data, ratio: await imageRatio(data) };
    } catch {
      floorplan = null;
    }
  }
  if (floorplan) {
    // 预裁成左栏框的比例：PPTX 的 addImage 只会按给定 w/h 缩放，
    // 不预裁就得靠 contain 留白，或者拉伸变形。户型图变形最难看。
    const [bw, bh] = FLOOR_BOX;
    try {
      floorplan.data = await coverCrop(floorplan.data, bw, bh, 'center');
      floorplan.ratio = bw / bh;
    } catch {
      /* 裁剪失败保留原图，宁可留白也不变形 */
    }
  }
  if (!floorplan && plan.floorplanUrl && plan.layoutPoints?.length) {
    try {
      const composed = await compositePoints(plan.floorplanUrl, plan.layoutPoints, 1400);
      const [bw, bh] = FLOOR_BOX;
      // 先合成点位再裁剪：点位图标已经画在图上，跟着一起裁，不会与点位错位
      const data = await coverCrop(composed, bw, bh, 'center');
      floorplan = { data, ratio: bw / bh };
    } catch {
      floorplan = null;
    }
  }

  // 有户型图素材时补一页「户型与设备点位」：分享页/预览/PPTX 必须页数一致
  const outPages = withFloorplanPage(plan.pages, Boolean(plan.floorplanUrl || plan.renderedFloorplanUrl)).pages;
  console.info('[pptx] 交付页数', outPages.length, '| 有户型图', Boolean(plan.floorplanUrl || plan.renderedFloorplanUrl));
  outPages.forEach((p, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: hex(t.bg) };
    switch (p.type) {
      case 'cover': coverSlide(slide, p, plan, t, img(p)); break;
      case 'brand': brandSlide(slide, p, i, plan, t, img(p)); break;
      case 'layout': layoutSlide(slide, p, i, plan, t, img(p), floorplan); break;
      case 'needs': needsSlide(slide, p, i, plan, t, img(p)); break;
      case 'ecosystem': ecosystemSlide(slide, p, i, plan, t, img(p)); break;
      case 'scene': sceneSlide(slide, p, i, plan, t, img(p)); break;
      case 'budget': budgetSlide(slide, p, i, plan, t, pptx); break;
      case 'delivery': deliverySlide(slide, p, i, plan, t, img(p), pptx); break;
      case 'floorplan': floorplanSlide(slide, p, i, plan, t, img(p), floorplan); break;
    }
    if (p.narration) slide.addNotes(p.narration);
  });

  const fileName = `${plan.title}-${plan.edition === 'private' ? '私宅' : plan.edition === 'presale' ? '售前' : '标准'}方案-V${plan.versionNo}-${new Date().toISOString().slice(0, 10)}.pptx`;
  // 浏览器里不能用 writeFile：那是 Node 端 API，会静默什么都不落盘，
  // 按钮转一圈然后什么都没有。write({outputType:'blob'}) 才是浏览器路径。
  console.info('[pptx] 写文件…');
  const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  console.info('[pptx] 字节数', buf.byteLength);
  // 用通用二进制类型：pptx 的 Office MIME 在部分宿主（Electron 内嵌浏览器）
  // 会被判定为不安全类型而静默丢弃，表现就是「转圈然后 Downloads 里什么都没有」。
  // 下载行为由后缀名决定，与 MIME 无关。
  downloadBlob(new Blob([buf], { type: 'application/octet-stream' }), fileName);
  console.info('[pptx] 已触发下载', fileName);
}

/* ---------- primitives ---------- */

function folio(slide: PptxGenJS.Slide, p: PlanPage, i: number, t: Theme, x: number, y: number, w: number, dark = false): void {
  slide.addText(
    [
      { text: String(i + 1).padStart(2, '0'), options: { fontSize: 11, bold: true, color: dark ? 'FFFFFF' : hex(t.accent) } },
      { text: `   ${PAGE_TYPE_LABEL[p.type]}`, options: { fontSize: 11, bold: true, color: dark ? 'FFFFFFCC' : hex(t.text) } },
      ...(p.subtitle ? [{ text: `      ${p.subtitle}`, options: { fontSize: 9.5, color: dark ? 'FFFFFFAA' : hex(t.sub) } }] : []),
    ],
    { x, y, w, h: 0.32, fontFace: FONT, valign: 'middle', margin: 0, wrap: false },
  );
  slide.addShape('line', { x, y: y + 0.44, w, h: 0, line: { color: hex(t.accent), width: 0.75, transparency: 55 } });
}

function claim(slide: PptxGenJS.Slide, p: PlanPage, t: Theme, x: number, y: number, w: number, h = 0.62, size = 22): void {
  const segs = p.heading.split('｜');
  slide.addText(
    segs.length > 1
      ? [{ text: `${segs[0]}｜`, options: { color: hex(t.text) } }, { text: segs.slice(1).join('｜'), options: { color: hex(t.accent) } }]
      : p.heading,
    { x, y, w, h, fontSize: size, bold: true, fontFace: FONT, valign: 'top', margin: 0, lineSpacingMultiple: 1.15 },
  );
}

function pointCard(slide: PptxGenJS.Slide, b: string, n: number, x: number, y: number, w: number, h: number, t: Theme): void {
  slide.addShape('roundRect', { x, y, w, h, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.07, shadow: SHADOW_SOFT });
  slide.addShape('ellipse', { x: x + 0.14, y: y + h / 2 - 0.13, w: 0.26, h: 0.26, fill: { color: hex(t.accent) }, shadow: { type: 'outer', color: hex(t.accent), blur: 4, offset: 1, angle: 90, opacity: 0.4 } });
  slide.addText(String(n).padStart(2, '0'), { x: x + 0.14, y: y + h / 2 - 0.13, w: 0.26, h: 0.26, fontSize: 8, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Arial', margin: 0, wrap: false });
  const [head, ...rest] = b.split(/[：|｜]/);
  slide.addText(
    rest.length ? [{ text: `${head}`, options: { bold: true, color: hex(t.text) } }, { text: ' · ', options: { color: hex(t.accent), bold: true } }, { text: rest.join(' '), options: { color: hex(t.sub) } }] : b,
    { x: x + 0.5, y: y + 0.03, w: w - 0.66, h: h - 0.06, fontSize: 10.5, valign: 'middle', fontFace: FONT, margin: 0, lineSpacingMultiple: 1.1 },
  );
}

function imagePanel(slide: PptxGenJS.Slide, data: string, x: number, y: number, w: number, h: number, t: Theme, label?: string): void {
  if (!data) return;
  slide.addImage({ data, x, y, w, h, shadow: SHADOW });
  slide.addShape('rect', { x, y, w, h, fill: { type: 'none' }, line: { color: hex(t.accent), width: 0.75, transparency: 65 } });
  if (label) {
    slide.addShape('rect', { x, y: y + h - 0.42, w, h: 0.42, fill: { color: '0F0A05', transparency: 32 } });
    slide.addText(label, { x: x + 0.14, y: y + h - 0.42, w: w - 0.28, h: 0.42, fontSize: 9, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'middle', margin: 0 });
  }
}

/** 暗调实景图提亮（pptxgenjs 无 filter，叠加半透明白层等效 brightness；transparency 越大越透明） */
function brighten(slide: PptxGenJS.Slide, x: number, y: number, w: number, h: number, transparency = 78): void {
  slide.addShape('rect', { x, y, w, h, fill: { color: 'FFFFFF', transparency } });
}

function quoteBar(slide: PptxGenJS.Slide, p: PlanPage, t: Theme, x: number, y: number, w: number): void {
  if (!p.quote) return;
  slide.addShape('roundRect', { x, y, w, h: 0.44, fill: { color: hex(t.surface) }, line: { type: 'none' }, rectRadius: 0.06, shadow: SHADOW_SOFT });
  slide.addShape('rect', { x, y, w: 0.06, h: 0.44, fill: { color: hex(t.accent) } });
  slide.addText(`“${p.quote}”`, { x: x + 0.2, y, w: w - 0.3, h: 0.44, fontSize: 10.5, italic: true, bold: true, color: hex(t.text), fontFace: FONT, valign: 'middle', margin: 0, wrap: false });
}

function footer(slide: PptxGenJS.Slide, plan: PlanForExport, t: Theme, x: number, y: number, w: number): void {
  slide.addText(
    [
      { text: plan.store || '全屋智能方案', options: { bold: true, color: hex(t.text) } },
      { text: '   ·   实际配置与报价以门店方案师现场确认为准', options: { color: hex(t.sub) } },
    ],
    { x, y, w, h: 0.24, fontSize: 7.5, fontFace: FONT, valign: 'middle', margin: 0 },
  );
}

/* ---------- compositions ---------- */

function coverSlide(slide: PptxGenJS.Slide, p: PlanPage, plan: PlanForExport, t: Theme, img: string): void {
  const iw = W * 0.42;
  if (img) slide.addImage({ data: img, x: W - iw, y: 0, w: iw, h: H });
  // 左色块压边（亮主题用白渐变过渡；深色直接色块）
  slide.addShape('rect', { x: 0, y: 0, w: W * 0.6, h: H, fill: { color: hex(t.bg) } });
  slide.addShape('rect', { x: W * 0.58, y: 0, w: 0.06, h: H, fill: { color: hex(t.accent) } });
  // 品牌行
  slide.addShape('roundRect', { x: 0.7, y: 0.62, w: 0.4, h: 0.4, fill: { color: hex(t.accent) }, rectRadius: 0.08, shadow: SHADOW_SOFT });
  slide.addText('智', { x: 0.7, y: 0.62, w: 0.4, h: 0.4, fontSize: 15, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, margin: 0 });
  slide.addText(plan.store || '全屋智能方案', { x: 1.22, y: 0.62, w: 5, h: 0.4, fontSize: 11, bold: true, color: hex(t.sub), fontFace: FONT, valign: 'middle', margin: 0, charSpacing: 2 });
  // 主张
  const segs = p.heading.split('｜');
  slide.addText(
    [{ text: `${segs[0]}｜`, options: { color: hex(t.text) } }, ...(segs[1] ? [{ text: segs[1], options: { color: hex(t.accent) } }] : [])],
    { x: 0.7, y: 1.9, w: 6.6, h: 1.9, fontSize: 33, bold: true, fontFace: FONT, lineSpacingMultiple: 1.22, valign: 'top', margin: 0 },
  );
  if (p.subtitle) slide.addText(p.subtitle, { x: 0.7, y: 3.75, w: 6.2, h: 0.5, fontSize: 14, color: hex(t.sub), fontFace: FONT, margin: 0 });
  // 价值卡（竖排玻璃条）
  p.bullets.slice(0, 3).forEach((b, ci) => {
    const y = 4.6 + ci * 0.72;
    slide.addShape('roundRect', { x: 0.7, y, w: 6.3, h: 0.6, fill: { color: hex(t.surface), transparency: 8 }, line: { color: hex(t.accent), width: 0.5, transparency: 60 }, rectRadius: 0.08, shadow: SHADOW_SOFT });
    slide.addShape('ellipse', { x: 0.88, y: y + 0.26, w: 0.09, h: 0.09, fill: { color: hex(t.accent) } });
    const [head, ...rest] = b.split(/[：|｜]/);
    slide.addText(
      [{ text: head, options: { bold: true, color: hex(t.accent) } }, ...(rest.length ? [{ text: `：${rest.join('：')}`, options: { color: hex(t.sub) } }] : [])],
      { x: 1.1, y, w: 5.8, h: 0.6, fontSize: 11, valign: 'middle', fontFace: FONT, margin: 0, wrap: false },
    );
  });
}

function brandSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, img: string): void {
  const colW = W - MX * 2;
  const imgW = 3.1;
  const leftW = colW - imgW - 0.4;
  folio(slide, p, i, t, MX, 0.5, leftW);
  claim(slide, p, t, MX, 1.12, leftW, 0.9, 21);
  slide.addText(p.body, { x: MX, y: 2.15, w: leftW, h: 1.35, fontSize: 11, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.5, valign: 'top', margin: 0 });
  // 2×2 数据卡
  const cards = p.bullets.slice(0, 4);
  const cw = (leftW - 0.24) / 2;
  cards.forEach((b, ci) => {
    const x = MX + (ci % 2) * (cw + 0.24);
    const y = 3.55 + Math.floor(ci / 2) * 1.4;
    slide.addShape('roundRect', { x, y, w: cw, h: 1.28, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.08, shadow: SHADOW });
    const [head, ...rest] = b.split(/[：|｜]/);
    slide.addText(head, { x: x + 0.16, y: y + 0.12, w: cw - 0.32, h: 0.32, fontSize: 12, bold: true, color: hex(t.accent), fontFace: FONT, margin: 0, wrap: false });
    slide.addText(rest.join(' '), { x: x + 0.16, y: y + 0.48, w: cw - 0.32, h: 0.68, fontSize: 9, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.25, valign: 'top', margin: 0 });
  });
  quoteBar(slide, p, t, MX, 6.42, leftW);
  footer(slide, plan, t, MX, 6.98, leftW);
  imagePanel(slide, img, W - MX - imgW, 0.5, imgW, H - 1.0, t, p.subtitle || '门店实景');
}

function layoutSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, img: string, floorplan: { data: string; ratio: number } | null): void {
  const imgW = 3.3;
  const panelY = 0.5;
  const panelH = H - 1.0;
  if (floorplan) {
    // 户型点位图：白底竖框 + 按原比例 contain 居中放置（横图裁进竖框会丢信息）
    slide.addShape('roundRect', { x: MX, y: panelY, w: imgW, h: panelH, fill: { color: 'FFFFFF' }, line: { color: lighten(t.accent, 0.7), width: 0.75 }, rectRadius: 0.12, shadow: SHADOW });
    let dw = imgW - 0.3;
    let dh = dw / floorplan.ratio;
    if (dh > panelH - 0.7) {
      dh = panelH - 0.7;
      dw = dh * floorplan.ratio;
    }
    slide.addImage({ data: floorplan.data, x: MX + (imgW - dw) / 2, y: panelY + (panelH - 0.42 - dh) / 2, w: dw, h: dh });
    slide.addShape('rect', { x: MX, y: panelY + panelH - 0.42, w: imgW, h: 0.42, fill: { color: '0F0A05', transparency: 32 } });
    slide.addText('客户户型 · 设备点位图', { x: MX + 0.14, y: panelY + panelH - 0.42, w: imgW - 0.28, h: 0.42, fontSize: 9, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'middle', margin: 0 });
  } else {
    imagePanel(slide, img, MX, panelY, imgW, panelH, t, '空间动线实景');
  }
  const x = MX + imgW + 0.4;
  const w = W - MX - x;
  folio(slide, p, i, t, x, 0.5, w);
  claim(slide, p, t, x, 1.12, w, 0.62, 20);
  slide.addText(p.body, { x, y: 1.82, w, h: 0.95, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.45, valign: 'top', margin: 0 });
  const bullets = p.bullets.slice(0, 6);
  const ch = Math.min(0.62, 3.0 / Math.max(bullets.length, 1));
  bullets.forEach((b, bi) => pointCard(slide, b, bi + 1, x, 2.9 + bi * (ch + 0.1), w, ch, t));
  quoteBar(slide, p, t, x, 6.28, w);
  footer(slide, plan, t, x, 6.92, w);
}

function needsSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, img: string): void {
  const bandH = 2.45;
  if (img) slide.addImage({ data: img, x: 0, y: 0, w: W, h: bandH });
  if (img) brighten(slide, 0, 0, W, bandH, 62);
  slide.addShape('rect', { x: 0, y: 0, w: W, h: bandH, fill: { color: '0F0A05', transparency: 55 } });
  slide.addText(p.subtitle || PAGE_TYPE_LABEL[p.type], { x: MX, y: 0.55, w: W - 2, h: 0.3, fontSize: 10, bold: true, color: 'FFFFFF', fontFace: FONT, charSpacing: 3, margin: 0 });
  const segs = p.heading.split('｜');
  slide.addText(
    [{ text: `${segs[0]}｜`, options: { color: 'FFFFFF' } }, ...(segs[1] ? [{ text: segs[1], options: { color: lighten(t.accent, 0.45) } }] : [])],
    { x: MX, y: 0.95, w: W - 1.32, h: 1.2, fontSize: 26, bold: true, fontFace: FONT, valign: 'top', margin: 0, lineSpacingMultiple: 1.15 },
  );
  const y0 = bandH + 0.35;
  const leftW = 3.6;
  slide.addText(p.body, { x: MX, y: y0, w: leftW, h: 2.2, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.55, valign: 'top', margin: 0 });
  quoteBar(slide, p, t, MX, 5.75, leftW);
  footer(slide, plan, t, MX, 6.9, leftW);
  const x = MX + leftW + 0.4;
  const w = W - MX - x;
  const bullets = p.bullets.slice(0, 5);
  const ch = Math.min(0.66, 3.6 / Math.max(bullets.length, 1));
  bullets.forEach((b, bi) => pointCard(slide, b, bi + 1, x, y0 - 0.05 + bi * (ch + 0.12), w, ch, t));
}

function ecosystemSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, img: string): void {
  const colW = W - MX * 2;
  const imgW = 3.4;
  const leftW = colW - imgW - 0.4;
  folio(slide, p, i, t, MX, 0.5, leftW);
  claim(slide, p, t, MX, 1.12, leftW, 0.62, 20);
  slide.addText(p.body, { x: MX, y: 1.85, w: leftW, h: 1.5, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.5, valign: 'top', margin: 0 });
  imagePanel(slide, img, W - MX - imgW, 0.5, imgW, 2.9, t, '智能中枢实景');
  // 底部生态卡横排
  const cards = p.bullets.slice(0, 5);
  const cw = (colW - 0.2 * (cards.length - 1)) / Math.max(cards.length, 1);
  cards.forEach((b, ci) => {
    const x = MX + ci * (cw + 0.2);
    slide.addShape('roundRect', { x, y: 3.85, w: cw, h: 1.85, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.08, shadow: SHADOW });
    slide.addShape('rect', { x, y: 3.85, w: cw, h: 0.07, fill: { color: hex(t.accent) } });
    const [head, ...rest] = b.split(/[：|｜]/);
    slide.addText(head, { x: x + 0.12, y: 4.02, w: cw - 0.24, h: 0.55, fontSize: 11, bold: true, color: hex(t.text), fontFace: FONT, valign: 'middle', margin: 0, lineSpacingMultiple: 1.1 });
    slide.addText(rest.join(' '), { x: x + 0.12, y: 4.6, w: cw - 0.24, h: 1.0, fontSize: 8.5, color: hex(t.sub), fontFace: FONT, valign: 'top', margin: 0, lineSpacingMultiple: 1.3 });
  });
  quoteBar(slide, p, t, MX, 6.1, colW * 0.62);
  footer(slide, plan, t, MX + colW * 0.66, 6.18, colW * 0.34);
}

function sceneSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, img: string): void {
  const imgW = W * 0.34;
  if (img) slide.addImage({ data: img, x: 0, y: 0, w: imgW, h: H });
  if (img) brighten(slide, 0, 0, imgW, H, 62);
  slide.addShape('rect', { x: 0, y: 0, w: imgW, h: H, fill: { color: '0F0A05', transparency: 45 } });
  // 场景徽章 + 主张（图下区）
  slide.addShape('roundRect', { x: 0.5, y: H - 2.6, w: 1.5, h: 0.34, fill: { color: hex(t.accent) }, rectRadius: 0.17, shadow: SHADOW_SOFT });
  slide.addText(PAGE_TYPE_LABEL[p.type], { x: 0.5, y: H - 2.6, w: 1.5, h: 0.34, fontSize: 8.5, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, margin: 0, wrap: false });
  slide.addText(p.heading, { x: 0.5, y: H - 2.1, w: imgW - 0.8, h: 1.4, fontSize: 16, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'top', margin: 0, lineSpacingMultiple: 1.25 });
  const x = imgW + 0.45;
  const w = W - x - MX;
  folio(slide, p, i, t, x, 0.5, w);
  slide.addText(p.body, { x, y: 1.15, w, h: 1.0, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.5, valign: 'top', margin: 0 });
  const bullets = p.bullets.slice(0, 5);
  const ch = Math.min(0.66, 3.3 / Math.max(bullets.length, 1));
  bullets.forEach((b, bi) => pointCard(slide, b, bi + 1, x, 2.3 + bi * (ch + 0.12), w, ch, t));
  quoteBar(slide, p, t, x, 6.0, w);
  footer(slide, plan, t, x, 6.85, w);
}

/**
 * 户型与设备点位页（PPTX 版）。
 *
 * 图用 contain：户型图被裁掉一半比看不清楚更严重。右侧按品类汇总点位，
 * 客户要确认的是「装了多少、都是些什么」，不是逐个编号。
 */
function floorplanSlide(
  slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme,
  img: string, floorplan: { data: string; ratio: number } | null,
): void {
  const rightW = 4.1;
  const x = W - rightW - MX;
  folio(slide, p, i, t, x, 0.5, rightW);
  claim(slide, p, t, x, 1.05, rightW, 0.9, 19);
  slide.addText(p.body, { x, y: 2.05, w: rightW, h: 1.5, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.55, valign: 'top', margin: 0 });

  // 品类汇总
  const m = new Map<string, number>();
  for (const pt of plan.layoutPoints ?? []) m.set(pt.category, (m.get(pt.category) ?? 0) + 1);
  const rows = [...m.entries()].slice(0, 8);
  const top = 3.7;
  const rowH = rows.length ? Math.min(0.42, (5.5 - top) / rows.length) : 0;
  rows.forEach(([category, count], ri) => {
    const y = top + ri * (rowH + 0.1);
    slide.addShape('roundRect', { x, y, w: rightW, h: rowH, fill: { color: hex(t.surface) }, line: { color: hex(t.accent), transparency: 82, width: 0.5 }, rectRadius: 0.08 });
    slide.addText(catMeta(category).label, { x: x + 0.16, y, w: rightW - 1.0, h: rowH, fontSize: 10, bold: true, color: hex(t.text), fontFace: FONT, valign: 'middle', margin: 0 });
    slide.addText(String(count), { x: x + rightW - 0.9, y, w: 0.74, h: rowH, fontSize: 12, bold: true, color: hex(t.accent), align: 'right', valign: 'middle', fontFace: FONT, margin: 0 });
  });
  quoteBar(slide, p, t, x, 5.85, rightW);
  footer(slide, plan, t, x, 6.85, rightW);

  // 左侧整页大图
  const boxW = x - 0.4;
  const boxH = H - 0.9;
  if (floorplan?.data) {
    // 主流程已按 FLOOR_BOX 预裁过，这里直接铺满，不留白
    slide.addImage({ data: floorplan.data, x: 0, y: 0.45, w: boxW, h: boxH });
  } else if (img) {
    // 没有上传户型图时用实景兜底，但要在图上说明，别让客户以为是自家户型
    slide.addImage({ data: img, x: 0, y: 0.45, w: boxW, h: boxH });
  }
  slide.addText(
    floorplan?.data ? (plan.renderedFloorplanUrl ? 'AI 精装修效果 · 点位同步' : '客户户型 · 设备点位图') : '空间实景示意（非客户户型）',
    { x: 0.22, y: H - 0.75, w: boxW - 0.44, h: 0.32, fontSize: 9.5, bold: true, color: 'FFFFFF', fill: { color: '0F0A05', transparency: 35 }, fontFace: FONT, valign: 'middle', margin: 0 },
  );
}

function budgetSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, pptx: PptxGenJS): void {
  const items = parseBudget(p.bullets)?.slice(0, 6);
  const leftW = 3.9;
  folio(slide, p, i, t, MX, 0.5, leftW);
  claim(slide, p, t, MX, 1.12, leftW, 0.9, 20);
  slide.addText(p.body, { x: MX, y: 2.15, w: leftW, h: 2.6, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.55, valign: 'top', margin: 0 });
  quoteBar(slide, p, t, MX, 5.6, leftW);
  footer(slide, plan, t, MX, 6.85, leftW);
  // 右：阴影面板 + 原生可编辑条形图
  const x = MX + leftW + 0.4;
  const w = W - MX - x;
  slide.addShape('roundRect', { x, y: 0.5, w, h: 5.9, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.1, shadow: SHADOW });
  slide.addText(
    [
      { text: '分项预算区间（元）', options: { fontSize: 12, bold: true, color: hex(t.text) } },
      { text: '    实际报价以现场确认为准', options: { fontSize: 8.5, color: hex(t.sub) } },
    ],
    { x: x + 0.25, y: 0.72, w: w - 0.5, h: 0.34, fontFace: FONT, margin: 0, valign: 'middle' },
  );
  if (items) {
    slide.addChart(pptx.ChartType.bar, [
      { name: '预算下限', labels: items.map((it) => it.name), values: items.map((it) => it.min) },
      { name: '预算上限', labels: items.map((it) => it.name), values: items.map((it) => it.max) },
    ], {
      x: x + 0.25, y: 1.2, w: w - 0.5, h: 4.95,
      barDir: 'bar', barGrouping: 'clustered', barGapWidthPct: 55, barOverlapPct: -12,
      chartColors: [lighten(t.accent, 0.55), hex(t.accent)],
      catAxisLabelColor: hex(t.text), catAxisLabelFontSize: 10, catAxisLabelFontFace: FONT,
      valAxisHidden: true,
      dataBorder: { pt: 0, color: 'FFFFFF' },
      showValue: true, dataLabelColor: hex(t.sub), dataLabelFontSize: 8, dataLabelPosition: 'outEnd', dataLabelFormatCode: '#,##0',
      legendPos: 'b', legendColor: hex(t.sub), legendFontSize: 9, legendFontFace: FONT,
    });
  } else {
    const bullets = p.bullets.slice(0, 6);
    const ch = Math.min(0.66, 4.6 / Math.max(bullets.length, 1));
    bullets.forEach((b, bi) => pointCard(slide, b, bi + 1, x + 0.25, 1.3 + bi * (ch + 0.12), w - 0.5, ch, t));
  }
}

function deliverySlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, img: string, pptx: PptxGenJS): void {
  const colW = W - MX * 2;
  const imgW = 2.6;
  const leftW = colW - imgW - 0.4;
  folio(slide, p, i, t, MX, 0.5, leftW);
  claim(slide, p, t, MX, 1.12, leftW, 0.62, 20);
  slide.addText(p.body, { x: MX, y: 1.85, w: leftW, h: 1.15, fontSize: 10, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.45, valign: 'top', margin: 0 });
  imagePanel(slide, img, W - MX - imgW, 0.5, imgW, 2.45, t);
  const stages = parseStages(p.bullets);
  if (stages) {
    const n = stages.length;
    const gap = 0.18;
    const cw = (colW - gap * (n - 1)) / n;
    const y = 3.3;
    const ch = 2.15;
    // 时间轴基线
    slide.addShape('line', { x: MX + cw / 2, y: y + 0.35, w: colW - cw, h: 0, line: { color: hex(t.accent), width: 1.2, transparency: 55 } });
    stages.forEach((s, si) => {
      const x = MX + si * (cw + gap);
      slide.addShape('roundRect', { x, y, w: cw, h: ch, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.08, shadow: SHADOW });
      slide.addShape('ellipse', { x: x + cw / 2 - 0.21, y: y + 0.14, w: 0.42, h: 0.42, fill: { color: hex(t.accent) }, line: { color: 'FFFFFF', width: 1.5 }, shadow: { type: 'outer', color: hex(t.accent), blur: 5, offset: 1, angle: 90, opacity: 0.45 } });
      slide.addText(String(si + 1).padStart(2, '0'), { x: x + cw / 2 - 0.21, y: y + 0.14, w: 0.42, h: 0.42, fontSize: 10, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Arial', margin: 0, wrap: false });
      slide.addText(s.name, { x: x + 0.08, y: y + 0.66, w: cw - 0.16, h: 0.34, fontSize: 11, bold: true, color: hex(t.text), align: 'center', fontFace: FONT, margin: 0, wrap: false });
      slide.addText(s.desc, { x: x + 0.1, y: y + 1.04, w: cw - 0.2, h: 1.0, fontSize: 8, color: hex(t.sub), align: 'center', fontFace: FONT, valign: 'top', margin: 0, lineSpacingMultiple: 1.3 });
    });
  } else {
    const bullets = p.bullets.slice(0, 5);
    const ch = Math.min(0.66, 3.2 / Math.max(bullets.length, 1));
    bullets.forEach((b, bi) => pointCard(slide, b, bi + 1, MX, 3.3 + bi * (ch + 0.12), colW, ch, t));
  }
  quoteBar(slide, p, t, MX, 5.85, colW * 0.62);
  footer(slide, plan, t, MX + colW * 0.66, 5.95, colW * 0.34);
}

/** 导出完整讲稿（每页讲解稿汇总为文本文件） */
export function buildNarrationText(plan: PlanForExport): string {
  const lines = [`# ${plan.title} · 完整讲解稿`, `版本 V${plan.versionNo}`, ''];
  withFloorplanPage(plan.pages, Boolean(plan.floorplanUrl || plan.renderedFloorplanUrl)).pages.forEach((p, i) => {
    // 标题与讲解稿都过净化：讲解稿是直接发给客户的，
    // 里面留着「待客户确认现场条件」这类内部语句会直接引发追问
    const heading = customerText(p.heading) || p.heading;
    lines.push(`## 第 ${i + 1} 页 · ${PAGE_TYPE_LABEL[p.type]}：${heading}`);
    lines.push(customerText(p.narration) || '（无讲解稿）');
    lines.push('');
  });
  return lines.join('\n');
}
