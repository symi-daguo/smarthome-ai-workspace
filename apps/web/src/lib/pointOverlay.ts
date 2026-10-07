/** 设备点位叠加共享模块：类别配色 + canvas 合成标注图（点位编辑器导出与方案 PPTX 共用） */

export interface PointLike {
  productId?: string;
  name: string;
  category: string;
  x: number;
  y: number;
}

export const CATEGORY_META: Record<string, { label: string; color: string }> = {
  gateway: { label: '网关网络', color: '#4FA8E0' },
  switch: { label: '开关控制', color: '#B07A4A' },
  sensor: { label: '传感器', color: '#5BA86B' },
  light: { label: '灯光', color: '#D9A036' },
  curtain: { label: '窗帘', color: '#8E7CC3' },
  security: { label: '安防', color: '#D06A5A' },
  appliance: { label: '家电控制', color: '#5AA8A0' },
  audio: { label: '影音', color: '#C37FB0' },
  hvac: { label: '暖通环境', color: '#7A8CA8' },
};

export const catMeta = (c: string): { label: string; color: string } => CATEGORY_META[c] ?? { label: c, color: '#888888' };

export function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 底图 + 半透明徽章点位 + 名称标签 合成为一张标注图纸（dataURL, JPEG） */
export async function compositePoints(baseSrc: string, points: PointLike[], targetW = 1600): Promise<string> {
  const img = await loadImage(baseSrc);
  const scale = Math.max(1, Math.min(3, targetW / img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseSrc;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const r = Math.max(14, canvas.width * 0.016);
  ctx.font = `bold ${Math.round(r * 0.95)}px "Microsoft YaHei", sans-serif`;
  for (const p of points) {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
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
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.name.slice(0, 1), x, y + r * 0.05);
    const tw = ctx.measureText(p.name).width;
    const lx = x + r + 6;
    const ly = y - r * 0.7;
    const pad = r * 0.45;
    ctx.fillStyle = 'rgba(20,15,10,.72)';
    ctx.beginPath();
    ctx.roundRect(lx - pad, ly - pad, tw + pad * 2, r * 1.5 + pad, r * 0.5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(p.name, lx, ly + r * 0.35);
  }
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
export async function compositeHeatmap(baseSrc: string, sources: PointLike[], targetW = 1600): Promise<string> {
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
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.1)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('W', x, y + r * 0.06);
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
  ctx.font = `bold ${Math.round(lh * 0.85)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('弱', lx - lh * 1.1, ly + lh * 0.8);
  ctx.fillText('强', lx + lw + lh * 0.4, ly + lh * 0.8);
  ctx.fillText('WiFi 信号覆盖热力（红=信号强）', lx, ly - lh * 0.5);
  return canvas.toDataURL('image/png');
}

/** 灯光点位效果图：灯具点位画暖光光晕 + 徽章标注 */
export async function compositeLightPlan(baseSrc: string, lights: PointLike[], targetW = 1600): Promise<string> {
  const prepared = await prepareCanvas(baseSrc, targetW);
  if (!prepared) return baseSrc;
  const { canvas, ctx } = prepared;
  addGlowLayer(canvas, ctx, lights, 0.14, [
    [0, 'rgba(255,214,140,0.95)'],
    [0.45, 'rgba(255,180,80,0.5)'],
    [1, 'rgba(255,180,80,0)'],
  ], 0.75);
  const r = Math.max(12, canvas.width * 0.013);
  ctx.font = `bold ${Math.round(r * 0.95)}px "Microsoft YaHei", sans-serif`;
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
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.name.slice(0, 1), x, y + r * 0.05);
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
