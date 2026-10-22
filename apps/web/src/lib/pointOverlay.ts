import { categoryIconDataUrl, productIconDataUrl } from './product-icons';
import { FONT_STACK_CANVAS } from '../theme/fonts';
import { catMeta as catMetaDict } from './categoryStore';
import { fileUrl } from './api';
import type { MarkerTemplate } from '../data/planTemplates';

/** 设备点位叠加共享模块：类别配色 + canvas 合成标注图（点位编辑器导出与方案 PPTX 共用） */

export interface PointLike {
  productId?: string;
  name: string;
  category: string;
  /** 产品主图（已解析的完整 URL）；门店上传了自家实拍就用实拍，加载失败回退产品图标，再回退品类图标 */
  iconUrl?: string;
  /** 产品级图标 key（同品类下不同产品用不同图标，否则一排标记分不清谁是谁） */
  iconKey?: string;
  /** 所属房间名：清单与图上编号按它对应（图上不画文字，名称由清单承担） */
  room?: string;
  x: number;
  y: number;
}

/** 品类元数据统一走 categoryStore（预置 24 类 + 自定义分类，字典加载失败自动兜底预置） */
export const catMeta = (c: string): { label: string; color: string } => {
  const { label, color } = catMetaDict(c);
  return { label, color };
};

/**
 * 合成图统一宽度（1.0.4）。
 *
 * 之前三端各传各的：分享页 1200、PPTX 1400、PNG 导出 1600。
 * 底图分辨率够高时三者结果相同（缩放倍数被下限 1 钳住，都按原图尺寸合成），
 * 但底图分辨率低的时候（比如 800px），三端会合成出 1200 / 1400 / 1600 三张不同大小的图，
 * 标记的**绝对像素**跟着变 —— 同一个方案在分享页、PPT、导出图里长得不一样。
 * 统一到 1600（PNG 导出的既有值，保真度最高的那一档）后，
 * 同一张底图 + 同一批点位，三端产出的是**同一张**合成图。
 */
export const COMPOSITE_WIDTH = 1600;

export function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * 底图 + 点位标记 合成为一张标注图纸（dataURL, PNG）。
 *
 * marker 决定标记样式（信号热力图模块的
 * 「图标 + 右上角编号 + 名称标签」模式，见 data/planTemplates.ts 的依据说明）：
 *   numbered —— 圆形徽章写编号 + 名称标签（默认，可与点位清单逐条对照）
 *   icon     —— 徽章贴产品主图/品类图标 + 名称标签（改前的老行为）
 *   dot      —— 按品类配色的小实心点 + 编号，名称全交给右侧清单
 *
 * 三种模式下标记的**编号都是 idx+1**，与点位清单顺序严格一致。
 */
export async function compositePoints(
  baseSrc: string,
  points: PointLike[],
  targetW = COMPOSITE_WIDTH,
  marker: MarkerTemplate = 'icon',
): Promise<string> {
  const img = await loadImage(baseSrc);
  const scale = Math.max(1, Math.min(3, targetW / img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseSrc;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // 预加载图标：产品主图优先（圆形裁剪），无图/失败回退品类 SVG
  const iconCache = new Map<string, HTMLImageElement>();
  const loadIcon = async (p: PointLike): Promise<HTMLImageElement | null> => {
    if (p.iconUrl) {
      try {
        return await loadImage(fileUrl(p.iconUrl));
      } catch {
        // 产品图不可用（跨域/已删除/分享页无 token），回退品类图标
      }
    }
    if (!iconCache.has(p.iconKey || p.category)) {
      try {
        iconCache.set(p.iconKey || p.category, await loadImage(productIconDataUrl(p.category, p.iconKey)));
      } catch {
        // 图标加载失败回退首字
      }
    }
    return iconCache.get(p.iconKey || p.category) ?? null;
  };
  const pointIcons = await Promise.all(points.map(loadIcon));
  const dot = marker === 'dot';
  const r = Math.max(14, canvas.width * (dot ? 0.009 : 0.016));
  ctx.font = `bold ${Math.round(r * (dot ? 1.3 : 0.95))}px ${FONT_STACK_CANVAS}`;
  points.forEach((p, idx) => {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
    const no = String(idx + 1);

    // —— dot：小实心点 + 右下角编号（点位密集时最干净）——
    if (dot) {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = catMeta(p.category).color + 'e6';
      ctx.shadowColor = 'rgba(0,0,0,.30)';
      ctx.shadowBlur = r * 0.45;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1.5, r * 0.22);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(r * 0.72)}px ${FONT_STACK_CANVAS}`;
      ctx.fillText(no, x, y + r * 0.04);
      return;
    }
    const color = catMeta(p.category).color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color + 'e6';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = r * 0.5;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    const icon = pointIcons[idx];
    // numbered：徽章中央写编号（与点位清单一一对应），不贴图标；
    // icon：徽章贴产品主图/品类图标。两者的徽章底色都按品类，视觉分类一致。
    if (marker !== 'numbered' && icon) {
      const s = r * 1.35;
      if (p.iconUrl) {
        // 产品照片：圆形裁剪贴入徽章
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, s / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
        const ratio = Math.max(s / icon.naturalWidth, s / icon.naturalHeight);
        const dw = icon.naturalWidth * ratio;
        const dh = icon.naturalHeight * ratio;
        ctx.drawImage(icon, x - dw / 2, y - dh / 2, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(icon, x - s / 2, y - s / 2, s, s);
      }
    } else {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(marker === 'numbered' ? no : p.name.slice(0, 1), x, y + r * 0.05);
    }
    /**
     * **不在图上画名称标签**（2026-10-22 实测后改）。
     *
     * 改前每个点位后面都挂一块深色名称牌，24 个点位在 140㎡ 户型上直接糊成一片：
     * 「亖米双色温灯带控制器mesh版」和「亖米Mesh二键开关Ultra-X30」互相压叠，
     * 客户根本读不出哪个标记是哪台设备 —— 图反而成了障碍。
     *
     * 现在图上只留**编号**（或品类图标），名称与编号的对应关系由右侧点位清单承担：
     * 清单逐条列「编号 + 名称 + 品类」，客户按编号对回图上的标记即可。
     * 行业规范要的「符号说明（图例）」在清单下方照旧保留。
     */
  });
  return canvas.toDataURL('image/png');
}

/** 与 compositePoints 相同的画布准备（按 targetW 缩放底图） */
async function prepareCanvas(baseSrc: string, targetW: number): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null> {
  const img = await loadImage(baseSrc);
  const scale = Math.max(1, Math.min(3, targetW / img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/** 透明叠加层上按点位画径向光斑（additive），再合成回主画布 */
function addGlowLayer(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, points: PointLike[], radiusRatio: number, stops: [number, string][], layerAlpha: number): void {
  const heat = document.createElement('canvas');
  heat.width = Math.max(2, Math.round(canvas.width / 4));
  heat.height = Math.max(2, Math.round(canvas.height / 4));
  const hctx = heat.getContext('2d');
  if (!hctx) return;
  hctx.globalCompositeOperation = 'lighter';
  const rr = canvas.width * radiusRatio / 4;
  for (const p of points) {
    const x = (p.x * heat.width);
    const y = (p.y * heat.height);
    const g = hctx.createRadialGradient(x, y, 0, x, y, rr);
    for (const [offset, color] of stops) g.addColorStop(offset, color);
    hctx.fillStyle = g;
    hctx.beginPath();
    hctx.arc(x, y, rr, 0, Math.PI * 2);
    hctx.fill();
  }
  ctx.save();
  ctx.globalAlpha = layerAlpha;
  ctx.drawImage(heat, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** WiFi 信号覆盖热力图：网关/AP 点位为热源，绿(弱)→黄→红(强)叠加，重叠区增强 */
export async function compositeHeatmap(baseSrc: string, sources: PointLike[], targetW = COMPOSITE_WIDTH): Promise<string> {
  const prepared = await prepareCanvas(baseSrc, targetW);
  if (!prepared) return baseSrc;
  const { canvas, ctx } = prepared;
  addGlowLayer(canvas, ctx, sources, 0.26, [
    [0, 'rgba(255,70,45,0.9)'],
    [0.35, 'rgba(255,190,60,0.55)'],
    [0.7, 'rgba(80,210,130,0.28)'],
    [1, 'rgba(80,210,130,0)'],
  ], 0.62);
  const r = Math.max(12, canvas.width * 0.013);
  const gwIcon = await loadImage(categoryIconDataUrl('gateway')).catch(() => null);
  for (const p of sources) {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1d3557e6';
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.15);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (gwIcon) {
      const s = r * 1.35;
      ctx.drawImage(gwIcon, x - s / 2, y - s / 2, s, s);
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.1)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('W', x, y + r * 0.06);
    }
  }
  // 图例
  const lw = canvas.width * 0.2;
  const lh = r * 1.2;
  const lx = canvas.width * 0.03;
  const ly = canvas.height - lh * 2.6;
  const grad = ctx.createLinearGradient(lx, 0, lx + lw, 0);
  grad.addColorStop(0, 'rgba(80,210,130,.85)');
  grad.addColorStop(0.5, 'rgba(255,190,60,.85)');
  grad.addColorStop(1, 'rgba(255,70,45,.9)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(lx, ly, lw, lh, lh / 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(20,15,10,.72)';
  ctx.font = `bold ${Math.round(lh * 0.85)}px ${FONT_STACK_CANVAS}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('弱', lx - lh * 1.1, ly + lh * 0.8);
  ctx.fillText('强', lx + lw + lh * 0.4, ly + lh * 0.8);
  ctx.fillText('WiFi 信号覆盖热力（红=信号强）', lx, ly - lh * 0.5);
  return canvas.toDataURL('image/png');
}

/**
 * 户型图美化（确定性增强，保持客户真实户型不变）：
 * 白底化 + 亮度/对比度拉伸 + 轻微锐化，输出 dataURL(PNG)。
 * 说明：刻意不用 AI 重绘——AI 生图会篡改墙体位置与房间尺寸，
 * 对销售交付是危险的；如需 AI 彩平图，走「AI 生图」板块自行生成示意稿。
 */
export async function enhanceFloorplan(baseSrc: string, targetW = 2000): Promise<string> {
  const img = await loadImage(baseSrc);
  const scale = Math.max(1, Math.min(3, targetW / img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseSrc;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  // 统计亮度分布，做对比度拉伸（截断 2% 离群值防过曝）
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) hist[(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0] += 1;
  const total = px.length / 4;
  let lo = 0; let hi = 255; let acc = 0;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v -= 1) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const span = Math.max(32, hi - lo);
  const gain = 255 / span;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      let v = (px[i + c] - lo) * gain;
      // 轻度 S 曲线：中间调对比增强，高亮区向白收敛（模拟干净图纸）
      v = v < 128 ? v * (v / 128) * 0.5 + v * 0.5 : v;
      px[i + c] = Math.max(0, Math.min(255, v));
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 灯光点位效果图：灯具点位画暖光光晕 + 徽章标注 */
export async function compositeLightPlan(baseSrc: string, lights: PointLike[], targetW = COMPOSITE_WIDTH): Promise<string> {
  const prepared = await prepareCanvas(baseSrc, targetW);
  if (!prepared) return baseSrc;
  const { canvas, ctx } = prepared;
  addGlowLayer(canvas, ctx, lights, 0.14, [
    [0, 'rgba(255,214,140,0.95)'],
    [0.45, 'rgba(255,180,80,0.5)'],
    [1, 'rgba(255,180,80,0)'],
  ], 0.75);
  const r = Math.max(12, canvas.width * 0.013);
  const lightIcon = await loadImage(categoryIconDataUrl('light')).catch(() => null);
  ctx.font = `bold ${Math.round(r * 0.95)}px ${FONT_STACK_CANVAS}`;
  for (const p of lights) {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#D9A036f0';
    ctx.shadowColor = 'rgba(217,160,54,.6)';
    ctx.shadowBlur = r;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (lightIcon) {
      const s = r * 1.35;
      ctx.drawImage(lightIcon, x - s / 2, y - s / 2, s, s);
    } else {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name.slice(0, 1), x, y + r * 0.05);
    }
    const tw = ctx.measureText(p.name).width;
    const pad = r * 0.4;
    ctx.fillStyle = 'rgba(20,15,10,.72)';
    ctx.beginPath();
    ctx.roundRect(x + r + 4 - pad, y - r * 0.7 - pad, tw + pad * 2, r * 1.4 + pad, r * 0.5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(p.name, x + r + 4, y - r * 0.7 + r * 0.75);
  }
  return canvas.toDataURL('image/png');
}
