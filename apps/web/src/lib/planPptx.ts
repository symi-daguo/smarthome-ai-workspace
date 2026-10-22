import PptxGenJS from 'pptxgenjs';
import { planTheme, PAGE_TYPE_LABEL, PAGE_IMAGE, sceneImage, type PlanPage } from '../data/planThemes';
import { catMeta, compositePoints, COMPOSITE_WIDTH } from './pointOverlay';
import { customerText } from './planSanitize';
import { floorplanListPageNo, quoteListPageNo, POINT_ROWS_PER_PAGE, QUOTE_ROWS_PER_PAGE, deliverPages, deliverPointCount, type QuoteSummary } from './planPages';
import { floorplanTemplate, markerTemplate } from '../data/planTemplates';

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
  layoutPoints?: { name: string; category: string; iconKey?: string; room?: string; x: number; y: number }[] | null;
  /** 户型图设计模版：annotated(点位标注) | compare(原图对照) | render(单图效果) */
  floorplanTemplate?: string | null;
  /** 产品放置模版：numbered(编号+名称) | icon(产品图+名称) | dot(色点+编号) */
  markerTemplate?: string | null;
  /** 设备清单与报价（按点位聚合，单价取产品库参考零售价） */
  quoteSummary?: QuoteSummary | null;
}

// 16:9 = 13.333 x 7.5 英寸
const W = 13.333;const H = 7.5;
const MX = 0.66; // 左右外边距
/** 户型页左栏图片框（英寸），与前端卡片的图片区保持同一比例 */
const FLOOR_BOX: [number, number] = [8.6, 6.15];

/**
 * 点位清单是否走「编号列表」版式、以及交付页序列，都放在 planPages.ts ——
 * 那是页序的唯一来源，PPTX / 讲稿 / 分享页都从那里取，改一处即可三处同步。
 */
import { FONT_PPTX } from '../theme/fonts';
import { cardShadow, cardShadowSoft } from './planShadow';
const FONT = FONT_PPTX;

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

export async function exportPlanPptx(plan: PlanForExport): Promise<{ blob: Blob; fileName: string }> {
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
  // 「原图对照」模版的左栏：未叠加点位的原始户型
  let leftImage: { data: string; ratio: number } | null = null;
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
  /**
   * 点位叠加：底图用「精装修效果图优先」，与 PlanSlide 的 useFloorplanVisual 同规则。
   * 此前条件是 `!floorplan && plan.floorplanUrl`，于是生成了精装修图之后
   * 点位合成被整段跳过 —— 页面上写着「户型与设备点位」，却一个点位都没有。
   *
   * 模版联动两处：
   *   - `render` 模版刻意不叠加点位（它就是「只放效果图」的展示型模版）
   *   - 标记样式由 markerTemplate 决定（编号 / 产品图 / 色点，见 data/planTemplates.ts）
   */
  const fpTpl = floorplanTemplate(plan.floorplanTemplate);
  const mkTpl = markerTemplate(plan.markerTemplate);
  if (plan.layoutPoints?.length && fpTpl !== 'render') {
    const base = (plan.floorplanUrl ?? plan.renderedFloorplanUrl) as string | null | undefined;
    if (base) {
      try {
        const composed = await compositePoints(base, plan.layoutPoints, COMPOSITE_WIDTH, mkTpl);
        // 先合成点位再裁剪：点位图标已经画在图上，跟着一起裁，不会与点位错位
        if (fpTpl === 'compare') {
          // 原图对照模版左栏要放**未叠加点位**的原始户型，对照才有意义
          const orig = await imgData(plan.floorplanUrl as string);
          const [bw, bh] = FLOOR_BOX;
          leftImage = { data: await coverCrop(orig, bw, bh, 'center'), ratio: bw / bh };
        }
        const [bw, bh] = FLOOR_BOX;
        floorplan = { data: await coverCrop(composed, bw, bh, 'center'), ratio: bw / bh };
      } catch {
        // 合成失败就沿用前面的底图，宁可没点位也不要整页丢图
      }
    }
  }
  if (fpTpl === 'compare' && !leftImage && plan.floorplanUrl) {
    try {
      const orig = await imgData(plan.floorplanUrl);
      const [bw, bh] = FLOOR_BOX;
      leftImage = { data: await coverCrop(orig, bw, bh, 'center'), ratio: bw / bh };
    } catch {
      /* 原图取不到就退回 annotated */
    }
  }

  // 有户型图素材时补一页「户型与设备点位」：分享页/预览/PPTX 必须页数一致
  const finalPages = deliverPages(plan).pages;
  const listCount = deliverPointCount(plan);
  console.info('[pptx] 交付页数', finalPages.length, '| 有户型图', Boolean(plan.floorplanUrl || plan.renderedFloorplanUrl), '| 点位清单', listCount);
  finalPages.forEach((p, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: hex(t.bg) };
    const listNo = floorplanListPageNo(finalPages, i);
    const quoteNo = quoteListPageNo(finalPages, i);
    switch (p.type) {
      case 'cover': coverSlide(slide, p, plan, t, img(p)); break;
      case 'brand': brandSlide(slide, p, i, plan, t, img(p)); break;
      case 'layout': layoutSlide(slide, p, i, plan, t, img(p), floorplan); break;
      case 'needs': needsSlide(slide, p, i, plan, t, img(p)); break;
      case 'ecosystem': ecosystemSlide(slide, p, i, plan, t, img(p)); break;
      case 'scene': sceneSlide(slide, p, i, plan, t, img(p)); break;
      case 'budget': budgetSlide(slide, p, i, plan, t, pptx); break;
      case 'delivery': deliverySlide(slide, p, i, plan, t, img(p), pptx); break;
      case 'floorplan': floorplanSlide(slide, p, i, plan, t, img(p), floorplan, leftImage, listNo); break;
      case 'quote': quoteSlide(slide, p, i, plan, t, quoteNo); break;
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
  // 产出而非直接下载：交付三件套要把它交给服务端打包（文件名得由服务端
  // Content-Disposition 决定 —— 浏览器 blob 下载的文件名实测一律变随机名）。
  // 单独下载的能力由调用方拿 blob 自己触发。
  return { blob: new Blob([buf], { type: 'application/octet-stream' }), fileName };
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
  slide.addShape('roundRect', { x, y, w, h, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.07, shadow: cardShadowSoft() });
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
  slide.addImage({ data, x, y, w, h, shadow: cardShadow() });
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
  slide.addShape('roundRect', { x, y, w, h: 0.44, fill: { color: hex(t.surface) }, line: { type: 'none' }, rectRadius: 0.06, shadow: cardShadowSoft() });
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
  slide.addShape('roundRect', { x: 0.7, y: 0.62, w: 0.4, h: 0.4, fill: { color: hex(t.accent) }, rectRadius: 0.08, shadow: cardShadowSoft() });
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
    slide.addShape('roundRect', { x: 0.7, y, w: 6.3, h: 0.6, fill: { color: hex(t.surface), transparency: 8 }, line: { color: hex(t.accent), width: 0.5, transparency: 60 }, rectRadius: 0.08, shadow: cardShadowSoft() });
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
    slide.addShape('roundRect', { x, y, w: cw, h: 1.28, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.08, shadow: cardShadow() });
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
    slide.addShape('roundRect', { x: MX, y: panelY, w: imgW, h: panelH, fill: { color: 'FFFFFF' }, line: { color: lighten(t.accent, 0.7), width: 0.75 }, rectRadius: 0.12, shadow: cardShadow() });
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
    slide.addShape('roundRect', { x, y: 3.85, w: cw, h: 1.85, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.08, shadow: cardShadow() });
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
  slide.addShape('roundRect', { x: 0.5, y: H - 2.6, w: 1.5, h: 0.34, fill: { color: hex(t.accent) }, rectRadius: 0.17, shadow: cardShadowSoft() });
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
 * 图用 contain：户型图被裁掉一半比看不清楚更严重。
 *
 * 右侧版式由 `floorplanTemplate` 决定（见 data/planTemplates.ts）：
 *   annotated（默认）—— 品类图例 + **编号点位清单**，客户能按编号把图上标记对回清单；
 *                       这正是行业对点位图的基本要求（图例 + 点位表），也是改前缺的那块。
 *   compare           —— 左半栏放未叠加点位的原始户型，右半栏放效果图，改造前后对照。
 *   render            —— 只放效果图，不叠加点位。
 *
 * 点位清单每页最多 9 条，超出的转入下一页（`floorplanExtraPages`），
 * 不做「取前 9 条」——那会让客户拿到的清单缺设备，施工交底时是事故。
 */
function floorplanSlide(
  slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme,
  img: string, floorplan: { data: string; ratio: number } | null,
  leftImage: { data: string; ratio: number } | null = null,
  listNo = 0,
): void {
  const tpl = floorplanTemplate(plan.floorplanTemplate);
  const points = plan.layoutPoints ?? [];
  /**
   * 编号清单的判定必须与 `deliverPointCount` **完全一致**，否则两处会打架：
   * deliverPointCount 决定「插几张清单页」，这里决定「画不画编号清单」。
   * 口径不一致时（此前 render 模版两处不同）会出现「页上写『续下页 · 还有 3 台』，
   * 但根本没有下一页」—— 客户永远拿不到那 3 台设备的编号。
   *
   * render 模版不叠加点位 → 图上没有徽章 → 不出编号清单（退回品类汇总）；
   * icon 模版标记上是产品图，编号无意义 → 同样退回品类汇总。
   */
  const numbered = tpl !== 'render' && markerTemplate(plan.markerTemplate) !== 'icon' && points.length > 0;

  const rightW = 4.1;
  const x = W - rightW - MX;
  // 右栏纵向分区：清单区 → 续页提示 → 图例 → 结论条 → 页脚
  const listTop = 3.28;
  const listMaxBottom = 5.58;
  const rowGap = 0.05;
  folio(slide, p, i, t, x, 0.5, rightW);
  claim(slide, p, t, x, 1.05, rightW, 0.9, 19);
  slide.addText(p.body, { x, y: 2.05, w: rightW, h: 1.05, fontSize: 10.5, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.55, valign: 'top', margin: 0 });

  if (numbered) {
    // —— 编号点位清单：编号与图上徽章严格一致（都是 idx+1）——
    // pageNo 是「这是第几张点位清单页」，用它算切片起点；
    // 不能用 points.indexOf(pt) 反查起点：同名设备会命中第一处，编号直接错位。
    const start = listNo * POINT_ROWS_PER_PAGE;
    const rows = points.slice(start, start + POINT_ROWS_PER_PAGE);
    // 行高按「清单区实际高度 ÷ 行数」算，且把行间距先扣掉：
    // 此前行距没算进去，9 行时清单底边会压到图例上，两块内容叠在一起。
    const rowH = rows.length
      ? Math.max(0.16, Math.min(0.34, (listMaxBottom - listTop - rows.length * rowGap) / rows.length))
      : 0;
    if (!rows.length) {
      slide.addText('本套方案未布设设备点位', { x, y: listTop, w: rightW, h: 0.4, fontSize: 10, color: hex(t.sub), fontFace: FONT, valign: 'middle', margin: 0 });
    }
    rows.forEach((pt, ri) => {
      const no = start + ri + 1;
      const y = listTop + ri * (rowH + rowGap);
      slide.addShape('roundRect', { x, y, w: rightW, h: rowH, fill: { color: hex(t.surface) }, line: { color: hex(t.accent), transparency: 86, width: 0.5 }, rectRadius: 0.06 });
      // 编号圆点：底色与图上该点的品类色一致
      const dot = Math.min(0.22, rowH * 0.86);
      slide.addShape('ellipse', { x: x + 0.1, y: y + rowH / 2 - dot / 2, w: dot, h: dot, fill: { color: catMeta(pt.category).color.replace('#', '') } });
      slide.addText(String(no), { x: x + 0.1, y: y + rowH / 2 - dot / 2, w: dot, h: dot, fontSize: 7.5, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, margin: 0 });
      slide.addText(pt.name, { x: x + 0.4, y, w: 1.95, h: rowH, fontSize: 9, bold: true, color: hex(t.text), fontFace: FONT, valign: 'middle', margin: 0 });
      // 房间列：点位表的标准列。没有房间名时留空（不写「-」占位，避免看起来像真信息）
      if (pt.room) {
        slide.addText(pt.room, { x: x + 2.42, y, w: 0.62, h: rowH, fontSize: 7.5, color: hex(t.accent), align: 'right', valign: 'middle', fontFace: FONT, margin: 0 });
      }
      slide.addText(catMeta(pt.category).label, { x: x + rightW - 1.0, y, w: 0.9, h: rowH, fontSize: 8, color: hex(t.sub), align: 'right', valign: 'middle', fontFace: FONT, margin: 0 });
    });
    // 分页提示：只在不是最后一张时显示「续下页」
    const more = points.length - start - rows.length;
    if (more > 0) {
      const hintY = listTop + rows.length * (rowH + rowGap) + 0.04;
      slide.addText(`续下页 · 还有 ${more} 台`, { x, y: hintY, w: rightW, h: 0.26, fontSize: 8.5, color: hex(t.accent), align: 'right', valign: 'middle', fontFace: FONT, margin: 0 });
    }
  } else {
    // —— 品类汇总（无编号模版 / 无点位时的兜底）——
    // 不截断：此前只列前 8 类，设备种类多的方案里客户看不到自己买的那几类。
    const m = new Map<string, number>();
    for (const pt of points) m.set(pt.category, (m.get(pt.category) ?? 0) + 1);
    const rows = [...m.entries()];
    const gap = 0.08;
    const rowH = rows.length ? Math.max(0.2, Math.min(0.42, (listMaxBottom - listTop - rows.length * gap) / rows.length)) : 0;
    rows.forEach(([category, count], ri) => {
      const y = listTop + ri * (rowH + gap);
      slide.addShape('roundRect', { x, y, w: rightW, h: rowH, fill: { color: hex(t.surface) }, line: { color: hex(t.accent), transparency: 82, width: 0.5 }, rectRadius: 0.08 });
      slide.addText(catMeta(category).label, { x: x + 0.16, y, w: rightW - 1.0, h: rowH, fontSize: 10, bold: true, color: hex(t.text), fontFace: FONT, valign: 'middle', margin: 0 });
      slide.addText(String(count), { x: x + rightW - 0.9, y, w: 0.74, h: rowH, fontSize: 12, bold: true, color: hex(t.accent), align: 'right', valign: 'middle', fontFace: FONT, margin: 0 });
    });
  }

  /**
   * 图例：品类色块 + 名称 + 数量（行业规范要求「每张图纸都有符号说明」）。
   *
   * **不截断**：此前只画前 5 个品类，而图上可能有 7 种颜色的点 —— 客户对不上图例，
   * 等于没有图例。这里用富文本流式排版（PowerPoint 自动换行），品类再多也不会少画。
   */
  const legend = [...new Map(points.map((pt) => [pt.category, catMeta(pt.category)])).entries()];
  if (legend.length) {
    const runs: { text: string; options: Record<string, unknown> }[] = [
      { text: '图例  ', options: { fontSize: 8, bold: true, color: hex(t.sub) } },
    ];
    legend.forEach(([category, meta], li) => {
      const n = points.filter((pt) => pt.category === category).length;
      if (li) runs.push({ text: '   ', options: { fontSize: 8, color: hex(t.sub) } });
      runs.push({ text: `■ ${meta.label}`, options: { fontSize: 8, bold: true, color: meta.color } });
      runs.push({ text: ` ${n}`, options: { fontSize: 8, color: hex(t.sub) } });
    });
    slide.addText(runs, { x, y: 5.86, w: rightW, h: 0.6, fontFace: FONT, valign: 'top', margin: 0, lineSpacingMultiple: 1.15 });
  }
  quoteBar(slide, p, t, x, 6.5, rightW);
  footer(slide, plan, t, x, 6.98, rightW);

  // 左侧图区
  const boxW = x - 0.4;
  const boxH = H - 0.9;
  if (tpl === 'compare' && leftImage && floorplan) {
    // 原图对照：左右各占一半，中间留缝
    const halfW = (boxW - 0.12) / 2;
    slide.addImage({ data: leftImage.data, x: 0, y: 0.45, w: halfW, h: boxH });
    slide.addImage({ data: floorplan.data, x: halfW + 0.12, y: 0.45, w: halfW, h: boxH });
    slide.addText('原始户型（客户户型图）', { x: 0.1, y: H - 0.75, w: halfW - 0.2, h: 0.32, fontSize: 9, bold: true, color: 'FFFFFF', fill: { color: '0F0A05', transparency: 40 }, fontFace: FONT, valign: 'middle', margin: 0 });
    slide.addText('AI 精装修效果 · 点位同步', { x: halfW + 0.22, y: H - 0.75, w: halfW - 0.2, h: 0.32, fontSize: 9, bold: true, color: 'FFFFFF', fill: { color: '0F0A05', transparency: 40 }, fontFace: FONT, valign: 'middle', margin: 0 });
    return;
  }
  if (floorplan?.data) {
    // 主流程已按 FLOOR_BOX 预裁过，这里直接铺满，不留白
    slide.addImage({ data: floorplan.data, x: 0, y: 0.45, w: boxW, h: boxH });
  } else if (img) {
    // 没有上传户型图时用实景兜底，但要在图上说明，别让客户以为是自家户型
    slide.addImage({ data: img, x: 0, y: 0.45, w: boxW, h: boxH });
  }
  const caption = !floorplan?.data
    ? '空间实景示意（非客户户型）'
    : tpl === 'render'
      ? 'AI 精装修效果示意（不含设备点位）'
      : '客户户型 · 设备点位图';
  slide.addText(caption, { x: 0.22, y: H - 0.75, w: boxW - 0.44, h: 0.32, fontSize: 9.5, bold: true, color: 'FFFFFF', fill: { color: '0F0A05', transparency: 35 }, fontFace: FONT, valign: 'middle', margin: 0 });
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
  slide.addShape('roundRect', { x, y: 0.5, w, h: 5.9, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.1, shadow: cardShadow() });
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

/**
 * 设备清单与报价页。
 *
 * 数据全部来自**产品库与真实点位**：数量 = 该款设备在平面图上的点位个数，
 * 单价 = 产品库参考零售价。不引用方案文案里的预算区间 ——
 * 那是模型给的估算区间，没有依据（实测点位设备参考价 9776 元，模型区间写 53000-80000 元）。
 *
 * 口径必须写清楚：设备参考零售价**不含**辅材、布线、安装与调试，
 * 否则客户拿这一页的合计当整包总价，差距会到好几倍。
 */
function quoteSlide(slide: PptxGenJS.Slide, p: PlanPage, i: number, plan: PlanForExport, t: Theme, pageNo: number): void {
  const sum = plan.quoteSummary;
  const fullW = W - MX * 2;
  const yuan = (n: number) => `¥${Math.round(n).toLocaleString('zh-CN')}`;
  folio(slide, p, i, t, MX, 0.5, fullW);
  claim(slide, p, t, MX, 1.0, 8.2, 0.8, 20);
  slide.addText(p.body, { x: MX, y: 1.86, w: 8.2, h: 0.72, fontSize: 10, color: hex(t.sub), fontFace: FONT, lineSpacingMultiple: 1.5, valign: 'top', margin: 0 });

  // 右上合计卡：整页的锚点数字
  const cardX = MX + 8.62;
  const cardW = fullW - 8.62;
  slide.addShape('roundRect', { x: cardX, y: 0.95, w: cardW, h: 1.58, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.1, shadow: cardShadow() });
  slide.addText('整包合计（含安装调试）', { x: cardX + 0.22, y: 1.06, w: cardW - 0.44, h: 0.3, fontSize: 9.5, bold: true, color: hex(t.sub), fontFace: FONT, valign: 'middle', margin: 0 });
  slide.addText(sum ? yuan(sum.grandTotal) : '—', { x: cardX + 0.22, y: 1.33, w: cardW - 0.44, h: 0.62, fontSize: 27, bold: true, color: hex(t.accent), fontFace: FONT, valign: 'middle', margin: 0 });
  // 拆项：设备价 + 安装调试费（费率来自租户设置，默认 20%）
  slide.addText(
    sum
      ? [
          { text: `设备 ${yuan(sum.total)}`, options: { fontSize: 8.5, color: hex(t.sub) } },
          { text: '  +  ', options: { fontSize: 8.5, color: hex(t.sub) } },
          { text: `安装调试 ${sum.installRate}% ${yuan(sum.installFee)}`, options: { fontSize: 8.5, color: hex(t.sub) } },
        ]
      : '',
    { x: cardX + 0.22, y: 1.97, w: cardW - 0.44, h: 0.3, fontFace: FONT, valign: 'middle', margin: 0 },
  );
  slide.addText(sum ? `共 ${sum.kindCount} 种设备 · ${sum.deviceCount} 台` : '', { x: cardX + 0.22, y: 2.22, w: cardW - 0.44, h: 0.28, fontSize: 8.5, color: hex(t.sub), fontFace: FONT, valign: 'middle', margin: 0 });

  if (!sum || !sum.items.length) {
    slide.addText('本套方案未产生设备报价', { x: MX, y: 3.0, w: fullW, h: 0.5, fontSize: 12, color: hex(t.sub), fontFace: FONT, valign: 'middle', margin: 0 });
    quoteBar(slide, p, t, MX, 6.5, fullW);
    footer(slide, plan, t, MX, 6.98, fullW);
    return;
  }

  // 表格：序号 / 设备名称 / 品类 / 数量 / 参考单价 / 小计
  const cols = [
    { key: 'no', w: 0.55, align: 'center' as const },
    { key: 'name', w: 5.4, align: 'left' as const },
    { key: 'cat', w: 1.45, align: 'left' as const },
    { key: 'qty', w: 0.85, align: 'right' as const },
    { key: 'unit', w: 1.85, align: 'right' as const },
    { key: 'sub', w: 1.85, align: 'right' as const },
  ];
  const headY = 2.62;
  const rowH = 0.225;
  const headH = 0.32;
  // 表头
  slide.addShape('roundRect', { x: MX, y: headY, w: fullW, h: headH, fill: { color: hex(t.accent) }, line: { type: 'none' }, rectRadius: 0.05 });
  const heads: Record<string, string> = { no: '序号', name: '设备名称', cat: '品类', qty: '数量', unit: '参考单价', sub: '小计' };
  let cx = MX;
  cols.forEach((c) => {
    slide.addText(heads[c.key], {
      x: cx + (c.align === 'right' ? 0 : 0.1), y: headY, w: c.w - 0.1, h: headH,
      fontSize: 9.5, bold: true, color: 'FFFFFF', align: c.align, fontFace: FONT, valign: 'middle', margin: 0,
    });
    cx += c.w;
  });

  // 数据行（按页切片，与点位清单页同一套分页规则）
  const start = pageNo * QUOTE_ROWS_PER_PAGE;
  const rows = sum.items.slice(start, start + QUOTE_ROWS_PER_PAGE);
  rows.forEach((it, ri) => {
    const y = headY + headH + ri * rowH;
    if (ri % 2 === 1) {
      slide.addShape('rect', { x: MX, y, w: fullW, h: rowH, fill: { color: hex(t.surface), transparency: 35 }, line: { type: 'none' } });
    }
    const cells: { text: string; options: Record<string, unknown> }[] = [
      { text: String(start + ri + 1), options: { color: hex(t.accent), bold: true } },
      { text: it.name, options: { color: hex(t.text), bold: true } },
      { text: catMeta(it.category).label, options: { color: hex(t.sub) } },
      { text: `${it.qty}`, options: { color: hex(t.text) } },
      { text: yuan(it.unitPrice), options: { color: hex(t.sub) } },
      { text: yuan(it.subtotal), options: { color: hex(t.text), bold: true } },
    ];
    let x = MX;
    cols.forEach((c, ci) => {
      slide.addText([cells[ci]], {
        x: x + (c.align === 'right' ? 0 : 0.1), y, w: c.w - 0.1, h: rowH,
        fontSize: 9.5, color: hex(t.text), align: c.align, fontFace: FONT, valign: 'middle', margin: 0,
      });
      x += c.w;
    });
    slide.addShape('line', { x: MX, y: y + rowH, w: fullW, h: 0, line: { color: hex(t.accent), transparency: 88, width: 0.5 } });
  });

  // 合计行：末页显示「设备 + 安装调试 + 整包」三项，非末页显示本页设备小计
  // 纵向位置：表头 0.32 + 14 行 × 0.225 = 3.47，表格底落在 6.09，
  // 合计行 6.15~6.49，引言条 6.5 起 —— 三者不叠。
  // （此前行高 0.245 时表格底到 6.13，合计行与引言条压在一起，已修）
  const pageSubtotal = rows.reduce((s, it) => s + it.subtotal, 0);
  const isLast = start + rows.length >= sum.items.length;
  const totalY = headY + headH + rows.length * rowH + 0.06;
  if (isLast) {
    // 末页：设备价 / 安装调试费 / 整包合计 并排，一行说清
    const runs: { text: string; options: Record<string, unknown> }[] = [
      { text: `设备 ${yuan(sum.total)}`, options: { fontSize: 9.5, color: hex(t.sub) } },
      { text: '   ·   ', options: { fontSize: 9.5, color: hex(t.sub) } },
      { text: `安装调试 ${sum.installRate}% ${yuan(sum.installFee)}`, options: { fontSize: 9.5, color: hex(t.sub) } },
      { text: '   ·   ', options: { fontSize: 9.5, color: hex(t.sub) } },
      { text: '整包合计 ', options: { fontSize: 9.5, bold: true, color: hex(t.sub) } },
      { text: yuan(sum.grandTotal), options: { fontSize: 12, bold: true, color: hex(t.accent) } },
    ];
    slide.addText(runs, { x: MX + 4.4, y: totalY, w: 7.55, h: 0.32, align: 'right', fontFace: FONT, valign: 'middle', margin: 0 });
  } else {
    slide.addText('本页小计', {
      x: MX + 6.9, y: totalY, w: 2.6, h: 0.32, fontSize: 9.5, bold: true, color: hex(t.sub), align: 'right', fontFace: FONT, valign: 'middle', margin: 0,
    });
    slide.addText(yuan(pageSubtotal), {
      x: MX + 9.55, y: totalY, w: 2.4, h: 0.32, fontSize: 10, bold: true,
      color: hex(t.text), align: 'right', fontFace: FONT, valign: 'middle', margin: 0,
    });
  }

  quoteBar(slide, p, t, MX, 6.5, fullW);
  footer(slide, plan, t, MX, 6.98, fullW);
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
      slide.addShape('roundRect', { x, y, w: cw, h: ch, fill: { color: hex(t.surface) }, line: { color: lighten(t.accent, 0.85), width: 0.5 }, rectRadius: 0.08, shadow: cardShadow() });
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
  // 页序列必须与 PPTX 走同一个入口（含点位清单续页），
  // 否则「讲稿第 7 页」和「PPT 第 7 页」对不上，门店照着讲会讲错页。
  deliverPages(plan).pages.forEach((p, i) => {
    // 标题与讲解稿都过净化：讲解稿是直接发给客户的，
    // 里面留着「待客户确认现场条件」这类内部语句会直接引发追问
    const heading = customerText(p.heading) || p.heading;
    lines.push(`## 第 ${i + 1} 页 · ${PAGE_TYPE_LABEL[p.type]}：${heading}`);
    lines.push(customerText(p.narration) || '（无讲解稿）');
    lines.push('');
  });
  return lines.join('\n');
}
