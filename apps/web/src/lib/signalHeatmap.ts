/**
 * WiFi 信号热力图算法模块（墙体识别 + 墙衰减信号场 + 覆盖率统计）。
 *
 * 分三层：
 * 1) 纯算法层：无任何 DOM 依赖，可直接用 `node --experimental-strip-types` 脚本化验证。
 *    灰度化 / Otsu / 距离变换 / 连通域标记 / 膨胀 / 墙体识别 / 网格洪水填充 / 覆盖率统计 / 颜色映射。
 * 2) 物理单位层：图纸实际米数 → 像素每米、覆盖半径与覆盖面积。
 * 3) Canvas 渲染层：热力叠加、墙线、每米网格、等值环、导出摘要、整图合成（仅供页面调用）。
 *
 * 坐标约定：对外接口一律归一化（0-1），与 DeviceLayout 的点位口径一致；
 * 识别流程内部使用像素坐标，最后一步统一归一化。
 */

/* ============================ 类型 ============================ */

export interface GrayImage {
  width: number;
  height: number;
  /** 长度 = width * height 的灰度值 */
  data: Uint8Array;
}

/** 归一化墙线段（0-1 坐标），端点可拖拽 */
export interface WallSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 信号源（网关/AP），归一化坐标 + 发射功率 */
export interface SignalSource {
  x: number;
  y: number;
  power: number;
}

/** 连通域统计（两遍扫描 + 并查集） */
export interface Comp {
  label: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
}

export interface CoverageStats {
  /** 参与统计的格子数（已扣除墙格） */
  totalCells: number;
  coveredCells: number;
  /** 覆盖率 0-1 */
  ratio: number;
  planAreaM2: number;
  coveredAreaM2: number;
  weakAreaM2: number;
  threshold: number;
  /**
   * 三档信号占比（0-1，2026-10-14 对齐参考站的「信号好 / 一般 / 弱」）。
   * 与 ratio 的区别：ratio 是二值「达标/不达标」，tiers 是三档分布，
   * 能看出「勉强能用」与「完全没信号」各占多少——只报一个总覆盖率看不出布点是否均匀。
   * 分档线取阈值的固定比例而非绝对值，这样拖动阈值滑块时两者的关系保持稳定。
   */
  tierGood: number;
  tierFair: number;
  tierWeak: number;
}

/* ============================ 通用 ============================ */

/** 线性插值（参考站 mix 语义） */
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ============================ 一、灰度化 ============================ */

/** 灰度化：BT.601 亮度权重 0.299 / 0.587 / 0.114，输入 RGBA 字节流 */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
    data[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  }
  return { width, height, data };
}

/* ============================ 二、Otsu 全局阈值 ============================ */

/**
 * Otsu 法求全局二值化阈值：
 * 先建 256 桶灰度直方图，再遍历所有候选阈值 t，把像素分成「暗类」[0,t] 与「亮类」[t+1,255]，
 * 取类间方差 σ²_b(t) = w0(t)·w1(t)·(μ0(t) − μ1(t))² 最大者（w 为占比，μ 为均值）。
 * 类内方差总和为常量，故最大化类间方差即最小化总类内方差，这就是 Otsu 的判据。
 * 返回值里的 betweenVariance 已按像素总数归一化，便于观察分离度。
 */
export function otsu(gray: GrayImage): { threshold: number; betweenVariance: number } {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.data.length; i += 1) hist[gray.data[i]] += 1;
  const total = gray.data.length;
  let sumAll = 0;
  let sqAll = 0;
  for (let v = 0; v < 256; v += 1) {
    sumAll += v * hist[v];
    sqAll += v * v * hist[v];
  }

  let sumDark = 0;
  let wDark = 0;
  let best = -1;
  let bestT = 0;
  for (let t = 0; t < 256; t += 1) {
    wDark += hist[t];
    if (wDark === 0) continue;
    const wLight = total - wDark;
    if (wLight === 0) break;
    sumDark += t * hist[t];
    const meanDark = sumDark / wDark;
    const meanLight = (sumAll - sumDark) / wLight;
    const between = wDark * wLight * (meanDark - meanLight) * (meanDark - meanLight);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  // 归一化为标准可分性 η = σ²_b / σ²_T ∈ [0,1]，越接近 1 说明墙与底色分得越干净
  const varianceTotal = sqAll / total - (sumAll / total) * (sumAll / total);
  return { threshold: bestT, betweenVariance: varianceTotal > 0 ? best / total / total / varianceTotal : 0 };
}

/** 按阈值二值化：dark = true 时深色像素记 1（户型图里墙线通常是深色） */
export function binarize(gray: GrayImage, threshold: number, dark = true): Uint8Array {
  const out = new Uint8Array(gray.width * gray.height);
  for (let i = 0; i < out.length; i += 1) {
    const isDark = gray.data[i] <= threshold;
    out[i] = (dark === isDark ? 1 : 0);
  }
  return out;
}

/* ============================ 三、距离变换（两遍 chamfer） ============================ */

/**
 * 到最近背景像素的距离（chamfer 3-4，两遍扫描）：
 * 前向扫描用左、左上、上、右上四个前驱，后向扫描用右、右下、下、左下四个后继，
 * 权重 3/4，最后除以 3 换算成近似欧氏距离。用于把墙线的「芯部」从边缘抗锯齿里剥出来。
 */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (x > 0) best = Math.min(best, d[i - 1] + 3);
      if (y > 0) {
        best = Math.min(best, d[i - width] + 3);
        if (x > 0) best = Math.min(best, d[i - width - 1] + 4);
        if (x < width - 1) best = Math.min(best, d[i - width + 1] + 4);
      }
      d[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (x < width - 1) best = Math.min(best, d[i + 1] + 3);
      if (y < height - 1) {
        best = Math.min(best, d[i + width] + 3);
        if (x < width - 1) best = Math.min(best, d[i + width + 1] + 4);
        if (x > 0) best = Math.min(best, d[i + width - 1] + 4);
      }
      d[i] = best;
    }
  }
  for (let i = 0; i < d.length; i += 1) d[i] /= 3;
  return d;
}

/* ============================ 四、连通域标记（两遍扫描 + 并查集） ============================ */

/** 两遍扫描连通域标记：前遍给临时标号并用并查集合并等价标号，后遍归并统计面积与包围盒 */
export function labelMask(mask: Uint8Array, width: number, height: number): { labels: Int32Array; comps: Comp[] } {
  const labels = new Int32Array(width * height);
  const parent: number[] = [0];
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const lo = Math.min(ra, rb);
    const hi = Math.max(ra, rb);
    parent[hi] = lo;
  };

  let next = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - width] : 0;
      if (!left && !up) {
        labels[i] = next;
        parent[next] = next;
        next += 1;
      } else if (left && up) {
        labels[i] = Math.min(left, up);
        if (left !== up) union(left, up);
      } else {
        labels[i] = left || up;
      }
    }
  }

  const acc = new Map<number, Comp>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!labels[i]) continue;
      const root = find(labels[i]);
      labels[i] = root;
      let c = acc.get(root);
      if (!c) {
        c = { label: root, area: 0, minX: x, minY: y, maxX: x, maxY: y, sumX: 0, sumY: 0 };
        acc.set(root, c);
      }
      c.area += 1;
      c.sumX += x;
      c.sumY += y;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
    }
  }
  return { labels, comps: [...acc.values()] };
}

/** 掩码膨胀（可分离滑窗，行列各一遍），用于桥接墙线上的抗锯齿断口 */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let miss = 0;
    for (let x = -radius; x <= radius; x += 1) if (x >= 0 && x < width && !mask[row + x]) miss += 1;
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = miss > 0 ? 0 : 1;
      const outL = x - radius;
      const inR = x + radius + 1;
      if (outL >= 0 && outL < width && !mask[row + outL]) miss -= 1;
      if (inR >= 0 && inR < width && !mask[row + inR]) miss += 1;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let miss = 0;
    for (let y = -radius; y <= radius; y += 1) if (y >= 0 && y < height && !tmp[y * width + x]) miss += 1;
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = miss > 0 ? 0 : 1;
      const outT = y - radius;
      const inB = y + radius + 1;
      if (outT >= 0 && outT < height && !tmp[outT * width + x]) miss -= 1;
      if (inB >= 0 && inB < height && !tmp[inB * width + x]) miss += 1;
    }
  }
  return out;
}

/** 掩码前景像素数 */
export function maskPixelCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) n += 1;
  return n;
}

/** 墙体识别参数（默认值针对 1000px 宽的分析图做过标定） */
export interface WallDetectOpts {
  /** 断线桥接膨胀半径（像素） */
  dilateRadius: number;
  /** 距离变换取芯比例：dist >= maxDist * coreRatio */
  coreRatio: number;
  /** 连通域最小面积（像素），滤掉文字噪点 */
  minArea: number;
  /** 最短墙长（占图宽比例） */
  minLengthRatio: number;
  /** 墙厚上限（像素） */
  maxThicknessPx: number;
  /** 细长度下限 = 长边 / 短边 */
  minElongation: number;
  /** 双线墙合并：间距上限（占图宽比例） */
  pairGapRatio: number;
  /** 双线墙合并：长度差容忍度 */
  pairLengthTol: number;
  /** 轴向吸附容差（弧度），偏离水平/垂直过多则丢弃 */
  axisSnapTol: number;
  /** 同轴线段合并间隙（像素） */
  mergeGapPx: number;
}

export const DEFAULT_WALL_OPTS: WallDetectOpts = {
  dilateRadius: 1,
  coreRatio: 0.45,
  minArea: 40,
  minLengthRatio: 0.06,
  maxThicknessPx: 14,
  minElongation: 4,
  pairGapRatio: 0.02,
  pairLengthTol: 0.4,
  axisSnapTol: Math.PI / 9,
  mergeGapPx: 12,
};

/** solidPass：孤立且致密的厚块（实心柱、家具色块、图签）判为实心区域，不作墙 */
export function solidPass(c: Comp, o: WallDetectOpts): boolean {
  const w = c.maxX - c.minX + 1;
  const h = c.maxY - c.minY + 1;
  const short = Math.min(w, h);
  const density = c.area / (w * h);
  return short > o.maxThicknessPx && density > 0.5;
}

/** linePass：面积、长度、细长度、短边厚度全部达标才算墙线候选 */
export function linePass(c: Comp, width: number, o: WallDetectOpts): boolean {
  if (c.area < o.minArea) return false;
  if (solidPass(c, o)) return false;
  const w = c.maxX - c.minX + 1;
  const h = c.maxY - c.minY + 1;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long < Math.max(8, width * o.minLengthRatio)) return false;
  if (short > o.maxThicknessPx) return false;
  return long / short >= o.minElongation;
}

/** solidPass 命中的连通域标记为禁止区，游程提取时跳过（滤掉家具块 / 文字） */
export function buildSolidMask(labels: Int32Array, comps: Comp[], o: WallDetectOpts): Uint8Array {
  const solid = new Uint8Array(labels.length);
  const hit = new Set<number>();
  for (const c of comps) if (solidPass(c, o)) hit.add(c.label);
  if (!hit.size) return solid;
  for (let i = 0; i < labels.length; i += 1) if (labels[i] && hit.has(labels[i])) solid[i] = 1;
  return solid;
}

/**
 * 游程法墙线提取：逐行 / 逐列扫描墙芯掩码取长游程，再用垂直方向的连通厚度判「细长」。
 *
 * 为什么不用连通域直接当墙：建筑平面图的墙体是连成一片的墙网（外墙与内墙在 T 型/十字节点处融合），
 * 单个连通域的包围盒会覆盖整张图，按面积/长宽比过滤会把所有墙一起丢掉。
 * 游程分解天然处理接缝：墙网在游程层面仍然表现为「一段够长且够薄」的直线。
 * 判据与 linePass 同源（长度 + 短边厚度 + 细长度），只是作用在游程而不是连通域上。
 */
export function extractRunSegments(core: Uint8Array, solid: Uint8Array, width: number, height: number, o: WallDetectOpts): WallSeg[] {
  const minLen = Math.max(8, width * o.minLengthRatio);
  const out: WallSeg[] = [];
  const usable = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && core[y * width + x] === 1 && solid[y * width + x] === 0;

  /** 沿垂直方向量测游程所在笔画厚度 */
  const thicknessAt = (x: number, y: number, horizontal: boolean): number => {
    let t = 0;
    const step = (k: number): boolean => (horizontal ? usable(x, y + k) : usable(x + k, y));
    let k = 0;
    while (step(k) && t <= o.maxThicknessPx + 2) {
      t += 1;
      k += 1;
    }
    k = -1;
    while (step(k) && t <= o.maxThicknessPx + 2) {
      t += 1;
      k -= 1;
    }
    return t;
  };

  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      if (!usable(x, y)) {
        x += 1;
        continue;
      }
      let end = x;
      while (end + 1 < width && usable(end + 1, y)) end += 1;
      const len = end - x + 1;
      if (len >= minLen) {
        // 取 25%/50%/75% 三处测厚并取最小值：T 型节点处局部变厚不应否决整段
        const t = Math.min(
          thicknessAt(x + (len >> 2), y, true),
          thicknessAt(x + (len >> 1), y, true),
          thicknessAt(x + ((len * 3) >> 2), y, true),
        );
        if (t <= o.maxThicknessPx && len / t >= o.minElongation) {
          out.push({ x1: x / width, y1: (y + 0.5) / height, x2: (end + 1) / width, y2: (y + 0.5) / height });
        }
      }
      x = end + 1;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let y = 0;
    while (y < height) {
      if (!usable(x, y)) {
        y += 1;
        continue;
      }
      let end = y;
      while (end + 1 < height && usable(x, end + 1)) end += 1;
      const len = end - y + 1;
      if (len >= minLen) {
        const t = Math.min(
          thicknessAt(x, y + (len >> 2), false),
          thicknessAt(x, y + (len >> 1), false),
          thicknessAt(x, y + ((len * 3) >> 2), false),
        );
        if (t <= o.maxThicknessPx && len / t >= o.minElongation) {
          out.push({ x1: (x + 0.5) / width, y1: y / height, x2: (x + 0.5) / width, y2: (end + 1) / height });
        }
      }
      y = end + 1;
    }
  }
  return out;
}

/** 距离的 98 分位（抗单块超厚元素干扰），代替绝对最大值作为取芯基准 */
function robustMaxDist(dist: Float32Array, mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < dist.length; i += 1) if (mask[i]) count += 1;
  if (count === 0) return 0;
  const bins = new Int32Array(256);
  for (let i = 0; i < dist.length; i += 1) {
    if (!mask[i]) continue;
    const b = Math.min(255, Math.max(0, Math.round(dist[i] * 4)));
    bins[b] += 1;
  }
  const want = count * 0.98;
  let acc = 0;
  for (let b = 0; b < 256; b += 1) {
    acc += bins[b];
    if (acc >= want) return b / 4;
  }
  return 255 / 4;
}

/** findPlanBounds：由连通域包围盒推断图纸内容范围，忽略零散噪点 */
export function findPlanBounds(comps: Comp[], width: number, height: number, minArea: number): Bounds | null {
  let b: Bounds | null = null;
  for (const c of comps) {
    if (c.area < minArea) continue;
    if (!b) b = { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY };
    else {
      b.x0 = Math.min(b.x0, c.minX);
      b.y0 = Math.min(b.y0, c.minY);
      b.x1 = Math.max(b.x1, c.maxX);
      b.y1 = Math.max(b.y1, c.maxY);
    }
  }
  if (!b) return null;
  return { x0: b.x0 / width, y0: b.y0 / height, x1: Math.min(1, b.x1 / width), y1: Math.min(1, b.y1 / height) };
}

/** constrainToBounds：把墙线段端点夹回图纸范围内（constrainMaskToSource 语义） */
export function constrainToBounds(segs: WallSeg[], b: Bounds): WallSeg[] {
  const cx = (v: number): number => Math.min(b.x1, Math.max(b.x0, v));
  const cy = (v: number): number => Math.min(b.y1, Math.max(b.y0, v));
  return segs.map((s) => ({ x1: cx(s.x1), y1: cy(s.y1), x2: cx(s.x2), y2: cy(s.y2) }));
}

const segLength = (s: WallSeg): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

/** 同轴线段合并：把断开的共线墙接成一条（先按方向分桶，两两判断轴向与间隙） */
export function mergeCollinear(segs: WallSeg[], gapPx: number, widthPx: number): WallSeg[] {
  const gap = gapPx / Math.max(1, widthPx);
  const used = new Array<boolean>(segs.length).fill(false);
  const out: WallSeg[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    let cur = { ...segs[i] };
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j += 1) {
        if (used[j]) continue;
        const cand = segs[j];
        const merged = tryMerge(cur, cand, gap);
        if (merged) {
          cur = merged;
          used[j] = true;
          grew = true;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

/** 两条线段同轴（共线或平行）且间隙足够小则拼成一条，返回 null 表示不可合并 */
function tryMerge(a: WallSeg, b: WallSeg, gap: number): WallSeg | null {
  const aHoriz = Math.abs(a.x2 - a.x1) >= Math.abs(a.y2 - a.y1);
  const bHoriz = Math.abs(b.x2 - b.x1) >= Math.abs(b.y2 - b.y1);
  if (aHoriz !== bHoriz) return null;
  if (aHoriz) {
    const ay = (a.y1 + a.y2) / 2;
    const by = (b.y1 + b.y2) / 2;
    if (Math.abs(ay - by) > gap) return null;
    const alo = Math.min(a.x1, a.x2);
    const ahi = Math.max(a.x1, a.x2);
    const blo = Math.min(b.x1, b.x2);
    const bhi = Math.max(b.x1, b.x2);
    if (blo - ahi > gap || alo - bhi > gap) return null;
    return { x1: Math.min(alo, blo), y1: ay, x2: Math.max(ahi, bhi), y2: ay };
  }
  const ax = (a.x1 + a.x2) / 2;
  const bx = (b.x1 + b.x2) / 2;
  if (Math.abs(ax - bx) > gap) return null;
  const alo = Math.min(a.y1, a.y2);
  const ahi = Math.max(a.y1, a.y2);
  const blo = Math.min(b.y1, b.y2);
  const bhi = Math.max(b.y1, b.y2);
  if (blo - ahi > gap || alo - bhi > gap) return null;
  return { x1: ax, y1: Math.min(alo, blo), x2: ax, y2: Math.max(ahi, bhi) };
}

/** pairChains：建筑图墙体多为双线，两条近平行、近等长、间距小的线判为同一道墙，取其中线输出 */
export function pairChains(segs: WallSeg[], o: WallDetectOpts): WallSeg[] {
  const gap = o.pairGapRatio;
  const consumed = new Array<boolean>(segs.length).fill(false);
  const out: WallSeg[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (consumed[i]) continue;
    consumed[i] = true;
    const a = segs[i];
    let best = -1;
    let bestScore = Infinity;
    for (let j = i + 1; j < segs.length; j += 1) {
      if (consumed[j]) continue;
      const b = segs[j];
      const aHoriz = Math.abs(a.x2 - a.x1) >= Math.abs(a.y2 - a.y1);
      const bHoriz = Math.abs(b.x2 - b.x1) >= Math.abs(b.y2 - b.y1);
      if (aHoriz !== bHoriz) continue;
      const la = segLength(a);
      const lb = segLength(b);
      if (Math.abs(la - lb) / Math.max(la, lb) > o.pairLengthTol) continue;
      // 平行间距：水平线比 y，垂直线比 x
      const perp = aHoriz ? Math.abs((a.y1 + a.y2 - b.y1 - b.y2) / 2) : Math.abs((a.x1 + a.x2 - b.x1 - b.x2) / 2);
      if (perp > gap) continue;
      // 沿长度方向的重叠必须足够，否则不是同一道墙
      const a0 = aHoriz ? Math.min(a.x1, a.x2) : Math.min(a.y1, a.y2);
      const a1 = aHoriz ? Math.max(a.x1, a.x2) : Math.max(a.y1, a.y2);
      const b0 = bHoriz ? Math.min(b.x1, b.x2) : Math.min(b.y1, b.y2);
      const b1 = bHoriz ? Math.max(b.x1, b.x2) : Math.max(b.y1, b.y2);
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap <= 0 || overlap / Math.max(la, lb) < 0.5) continue;
      if (perp < bestScore) {
        bestScore = perp;
        best = j;
      }
    }
    if (best < 0) {
      out.push(a);
      continue;
    }
    consumed[best] = true;
    const b = segs[best];
    out.push({
      x1: (a.x1 + b.x1) / 2,
      y1: (a.y1 + b.y1) / 2,
      x2: (a.x2 + b.x2) / 2,
      y2: (a.y2 + b.y2) / 2,
    });
  }
  return out;
}

export interface WallDetectResult {
  /** 归一化墙线段（可直接渲染 + 拖端点修正） */
  segments: WallSeg[];
  threshold: number;
  /** 归一化类间方差，越大说明墙与底色分离得越干净 */
  separation: number;
  /** 通过 linePass 的连通域数量 */
  candidates: number;
  bounds: Bounds | null;
}

/**
 * 墙体识别主流程（确定性纯前端 CV，不调任何 AI 接口）：
 * 灰度化 → Otsu 全局阈值二值化 → 膨胀桥接断口 → 距离变换取墙线芯部
 * → 两遍连通域标记 → solidPass 滤实心块 / linePass 收细长线 → 轴向吸附
 * → 同轴合并 → pairChains 双线合并 → 约束在图纸范围内 → 归一化输出。
 */
export function detectWalls(gray: GrayImage, opts?: Partial<WallDetectOpts>): WallDetectResult {
  const o = { ...DEFAULT_WALL_OPTS, ...opts };
  const { width, height } = gray;
  if (width < 8 || height < 8) return { segments: [], threshold: 0, separation: 0, candidates: 0, bounds: null };

  const { threshold, betweenVariance } = otsu(gray);
  const ink = binarize(gray, threshold, true);
  const bridged = dilateMask(ink, width, height, o.dilateRadius);

  const dist = distanceTransform(bridged, width, height);
  const maxDist = robustMaxDist(dist, bridged);
  if (maxDist <= 0) return { segments: [], threshold, separation: betweenVariance, candidates: 0, bounds: null };

  // 墙线芯部：距离 ≥ 稳健最大距离的一定比例，只有线中心与足够厚的笔画能满足
  const coreFloor = Math.max(1, maxDist * o.coreRatio);
  const core = new Uint8Array(width * height);
  for (let i = 0; i < core.length; i += 1) core[i] = bridged[i] && dist[i] >= coreFloor ? 1 : 0;

  const { labels, comps } = labelMask(core, width, height);
  const candidates = comps.filter((c) => linePass(c, width, o)).length;
  const solid = buildSolidMask(labels, comps, o);

  const runs = extractRunSegments(core, solid, width, height, o);
  const merged = mergeCollinear(runs, o.mergeGapPx, width);
  const paired = pairChains(merged, o);
  const bounds = findPlanBounds(comps, width, height, o.minArea);
  const segments = bounds ? constrainToBounds(paired, bounds) : paired;
  return { segments, threshold, separation: betweenVariance, candidates, bounds };
}

/* ============================ 五、墙几何查询 ============================ */

/** 线段相交（叉积，含端点相接） */
function segmentsIntersect(a: WallSeg, b: WallSeg): boolean {
  const d = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = d(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d2 = d(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const d3 = d(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d4 = d(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return ((d1 <= 0 && d2 >= 0) || (d1 >= 0 && d2 <= 0)) && ((d3 <= 0 && d4 >= 0) || (d3 >= 0 && d4 <= 0));
}

/** countWallsBetween：两点连线穿过的墙数（用于精确校验，渲染内层用栅格化查表） */
export function countWallsBetween(segs: WallSeg[], x1: number, y1: number, x2: number, y2: number): number {
  const probe: WallSeg = { x1, y1, x2, y2 };
  let n = 0;
  for (const s of segs) {
    if (Math.abs(s.x1 - s.x2) < 1e-9 && Math.abs(s.y1 - s.y2) < 1e-9) continue;
    if (segmentsIntersect(probe, s)) n += 1;
  }
  return n;
}

/** wallAt：归一化点是否落在某道墙上（容差按图纸宽度折算） */
export function wallAt(segs: WallSeg[], x: number, y: number, tol: number): boolean {
  return countWallsBetween(segs, x - tol, y, x + tol, y) > 0 || countWallsBetween(segs, x, y - tol, x, y + tol) > 0;
}

/** 点到线段的距离（画端点命中判定用） */
export function distanceToSeg(s: WallSeg, x: number, y: number): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((x - s.x1) * dx + (y - s.y1) * dy) / len2));
  return Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy));
}

/* ============================ 六、信号场（网格洪水填充） ============================ */

export interface FieldOpts {
  cols: number;
  rows: number;
  /** 归一化墙线段 */
  walls: WallSeg[];
  sources: SignalSource[];
  /** 每穿一道墙的衰减系数（默认 0.62） */
  wallAtten: number;
  /** 每格自由空间衰减（<1） */
  freeAtten: number;
  /** 有效信号下限，低于即停止扩散 */
  threshold: number;
  /** 墙体厚度（米），用于把墙栅格化到网格上；缺省 0.12 */
  wallThicknessM?: number;
  /** 图纸宽度（米），用于把墙厚换算成格数 */
  planWidthM?: number;
}

/** 墙体在信号网格上的栅格化结果 */
export interface WallRaster {
  cols: number;
  rows: number;
  /** 1 = 墙格（不计入覆盖面积） */
  cells: Uint8Array;
  /** (y*cols+x)=1：格 (x,y) → (x+1,y) 的水平连线穿墙 */
  crossH: Uint8Array;
  /** (y*cols+x)=1：格 (x,y) → (x,y+1) 的垂直连线穿墙 */
  crossV: Uint8Array;
}

/**
 * 把归一化墙线段栅格化成信号网格：沿墙线做细步长 DDA，
 * 沿途标记墙格（方形笔刷，厚度按米换算），并在相邻格子之间标记「连线穿墙」。
 * 这一步是 BFS 内层能跑得动的原因：每步只需查一次布尔表，无需逐段求交。
 */
export function rasterizeWalls(cols: number, rows: number, segs: WallSeg[], thicknessCells: number): WallRaster {
  const n = cols * rows;
  const cells = new Uint8Array(n);
  const crossH = new Uint8Array(n);
  const crossV = new Uint8Array(n);
  const t = Math.max(0, Math.round(thicknessCells));
  const markCell = (cx: number, cy: number): void => {
    for (let dy = -t; dy <= t; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y >= rows) continue;
      for (let dx = -t; dx <= t; dx += 1) {
        const x = cx + dx;
        if (x < 0 || x >= cols) continue;
        cells[y * cols + x] = 1;
      }
    }
  };
  const markCross = (ax: number, ay: number, bx: number, by: number): void => {
    // 每面墙只在「刚进入墙体带」的那一步标记一次：
    // 竖直墙占列 [lo,hi]，只有 crossH[lo-1] 这一步会离开墙体带，因此左右双向穿越都恰好记一次衰减。
    if (ay === by) {
      // 水平墙占行 [ay-t, ay+t]，只有纵跨 y=ay-t-1 这一条边才算「进出墙体带」；
      // 标记范围要按墙体带两端各外扩 t，否则转角处会漏过不衰减的缝隙。
      const y = Math.max(0, Math.min(ay, by) - t - 1);
      const x0 = Math.max(0, Math.min(ax, bx) - t);
      const x1 = Math.min(cols - 1, Math.max(ax, bx) + t);
      if (y < rows - 1) for (let x = x0; x <= x1; x += 1) crossV[y * cols + x] = 1;
    } else if (ax === bx) {
      const x = Math.max(0, Math.min(ax, bx) - t - 1);
      const y0 = Math.max(0, Math.min(ay, by) - t);
      const y1 = Math.min(rows - 1, Math.max(ay, by) + t);
      if (x < cols - 1) for (let y = y0; y <= y1; y += 1) crossH[y * cols + x] = 1;
    } else {
      const x = Math.max(0, Math.min(ax, bx) - t - 1);
      const y = Math.max(0, Math.min(ay, by) - t - 1);
      const x0 = Math.max(0, Math.min(ax, bx) - t);
      const x1 = Math.min(cols - 1, Math.max(ax, bx) + t);
      const y0 = Math.max(0, Math.min(ay, by) - t);
      const y1 = Math.min(rows - 1, Math.max(ay, by) + t);
      if (x < cols - 1) for (let yy = y0; yy <= y1; yy += 1) crossH[yy * cols + x] = 1;
      if (y < rows - 1) for (let xx = x0; xx <= x1; xx += 1) crossV[y * cols + xx] = 1;
    }
  };

  for (const s of segs) {
    const dx = (s.x2 - s.x1) * (cols - 1);
    const dy = (s.y2 - s.y1) * (rows - 1);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4));
    let px = -1;
    let py = -1;
    for (let k = 0; k <= steps; k += 1) {
      const tt = k / steps;
      const cx = Math.round(mix(s.x1, s.x2, tt) * (cols - 1));
      const cy = Math.round(mix(s.y1, s.y2, tt) * (rows - 1));
      if (cx === px && cy === py) continue;
      if (px >= 0) markCross(px, py, cx, cy);
      markCell(cx, cy);
      px = cx;
      py = cy;
    }
  }
  return { cols, rows, cells, crossH, crossV };
}

/** 依据图纸尺寸与分辨率选择信号网格规模（限制总格数保证交互帧率） */
export function fieldGrid(widthPx: number, heightPx: number, targetCells = 22000): { cols: number; rows: number } {
  const aspect = Math.max(0.05, heightPx / Math.max(1, widthPx));
  const cols = Math.max(16, Math.min(320, Math.round(Math.sqrt(targetCells / aspect))));
  const rows = Math.max(16, Math.min(320, Math.round(cols * aspect)));
  return { cols, rows };
}

/**
 * 网格洪水填充求信号场：
 * 以每个设备为源做四向 BFS，每前进一步乘自由空间衰减，每穿过一道墙再乘墙衰减系数
 * （墙数 k 的路径即衰减 wallAtten^k），格子只保留所有路径中的最强值。
 * 墙格本身场值置 0（墙不算可覆盖空间），但信号允许穿过并按墙数衰减——这与
 * 「只沿未被墙阻断的路径传播」不矛盾：墙阻断的是直线穿透，不阻断绕行与穿透后的强度。
 */
export function computeSignalField(o: FieldOpts): Float32Array {
  const { cols, rows, walls, sources, wallAtten, freeAtten, threshold } = o;
  const n = cols * rows;
  const field = new Float32Array(n);
  if (!sources.length) return field;

  const planWidthM = o.planWidthM && o.planWidthM > 0 ? o.planWidthM : 1;
  // 墙厚（米）→ 栅格格数：归一化宽度 1/planWidthM 米对应 cols-1 格
  const thicknessCells = Math.max(0, Math.round(((o.wallThicknessM ?? 0.12) / planWidthM) * (cols - 1)));
  const raster = rasterizeWalls(cols, rows, walls, thicknessCells);

  const strength = new Float32Array(n);

  for (const src of sources) {
    if (src.power <= 0) continue;
    strength.fill(0);
    // 用普通数组 + 头指针当队列：路径含墙数不同，同一格可能被多次改进，固定长度环形队列会溢出
    const queue: number[] = [];
    let head = 0;
    const sx = Math.min(cols - 1, Math.max(0, Math.round(src.x * (cols - 1))));
    const sy = Math.min(rows - 1, Math.max(0, Math.round(src.y * (rows - 1))));
    const si = sy * cols + sx;
    strength[si] = src.power;
    queue.push(si);
    while (head < queue.length) {
      const i = queue[head];
      head += 1;
      const cur = strength[i];
      if (cur < threshold) continue;
      const x = i % cols;
      const y = (i / cols) | 0;
      // 四向扩散：穿墙只扣一次衰减系数（墙格最后统一归零），不阻断整体传播。
      // 注意索引方向：向左/向上移动时，跨墙标记要用「目标格」所在的那条边，而不是当前格。
      for (let d = 0; d < 4; d += 1) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const ni = ny * cols + nx;
        const crossed = d === 0 ? raster.crossH[i] : d === 1 ? raster.crossH[i - 1] : d === 2 ? raster.crossV[i] : raster.crossV[i - cols];
        let next = cur * freeAtten;
        if (crossed) next *= wallAtten;
        // 只有严格更强才入队，兼作「已访问」判据
        if (next < threshold || next <= strength[ni]) continue;
        strength[ni] = next;
        queue.push(ni);
      }
    }
    for (let i = 0; i < n; i += 1) if (strength[i] > field[i]) field[i] = strength[i];
  }

  for (let i = 0; i < n; i += 1) if (raster.cells[i]) field[i] = 0;
  return field;
}

/** signalAt：按归一化坐标双线性采样信号强度 */
export function signalAt(field: Float32Array, cols: number, rows: number, x: number, y: number): number {
  const fx = clamp01(x) * (cols - 1);
  const fy = clamp01(y) * (rows - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = field[y0 * cols + x0];
  const b = field[y0 * cols + x1];
  const c = field[y1 * cols + x0];
  const d = field[y1 * cols + x1];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

/**
 * measureCoverageStats：统计「信号强度 ≥ 阈值」的格子占比。
 * 单格面积 = (图纸宽/列数) × (图纸高/行数)，据此换算覆盖面积㎡与弱信号区面积㎡。
 */
export function measureCoverageStats(
  field: Float32Array,
  cols: number,
  rows: number,
  opts: { threshold: number; planWidthM: number; planHeightM: number; wallMask?: Uint8Array },
): CoverageStats {
  const cellW = opts.planWidthM / Math.max(1, cols);
  const cellH = opts.planHeightM / Math.max(1, rows);
  const cellArea = Math.max(0, cellW * cellH);
  let covered = 0;
  let total = 0;
  // 三档分档线：好 ≥ 阈值、一般 ≥ 0.35×阈值、其余为弱。与 ratio 共用同一趟扫描，不额外遍历。
  let good = 0;
  let fair = 0;
  const fairLine = opts.threshold * 0.35;
  for (let i = 0; i < field.length; i += 1) {
    if (opts.wallMask && opts.wallMask[i]) continue;
    total += 1;
    const v = field[i];
    if (v >= opts.threshold) {
      covered += 1;
      good += 1;
    } else if (v >= fairLine) {
      fair += 1;
    }
  }
  const planArea = Math.max(0, opts.planWidthM) * Math.max(0, opts.planHeightM);
  return {
    totalCells: total,
    coveredCells: covered,
    ratio: total > 0 ? covered / total : 0,
    planAreaM2: planArea,
    coveredAreaM2: covered * cellArea,
    weakAreaM2: (total - covered) * cellArea,
    threshold: opts.threshold,
    tierGood: total > 0 ? good / total : 0,
    tierFair: total > 0 ? fair / total : 0,
    tierWeak: total > 0 ? Math.max(0, total - covered - fair) / total : 0,
  };
}

/** heatColor：强度 → 颜色。与既有图例一致：绿(弱) → 黄 → 红(强) */
export function heatColor(t: number): [number, number, number] {
  const v = clamp01(t);
  const stops: [number, number, number][] = [
    [80, 210, 130],
    [255, 190, 60],
    [255, 70, 45],
  ];
  const k = v < 0.5 ? 0 : 1;
  const lt = v < 0.5 ? v * 2 : (v - 0.5) * 2;
  return [
    Math.round(mix(stops[k][0], stops[k + 1][0], lt)),
    Math.round(mix(stops[k][1], stops[k + 1][1], lt)),
    Math.round(mix(stops[k][2], stops[k + 1][2], lt)),
  ];
}

/* ============================ 七、物理单位 ============================ */

/** 图纸实际宽度（米）：优先用户输入，否则按 10m 兜底估算 */
export function widthMeters(pixelWidth: number, inputM?: number, fallbackM = 10): number {
  if (inputM !== undefined && Number.isFinite(inputM) && inputM > 0) return inputM;
  return Math.max(0.1, (pixelWidth / 1000) * fallbackM);
}

/** 图纸实际高度（米）：优先用户输入，否则按宽度与像素比例换算 */
export function heightMeters(pixelWidth: number, pixelHeight: number, inputM?: number, fallbackM = 10): number {
  if (inputM !== undefined && Number.isFinite(inputM) && inputM > 0) return inputM;
  return Math.max(0.1, (pixelHeight / Math.max(1, pixelWidth)) * fallbackM);
}

/** xPixelsPerMeter：像素每米（比例尺） */
export function pixelsPerMeter(pixelWidth: number, widthM: number): number {
  return pixelWidth / Math.max(0.01, widthM);
}

/**
 * 理论覆盖半径（米）：自由空间按每米衰减 freeAttenPerMeter，
 * 穿 k 道墙再乘 wallAtten^k；解 power · wallAtten^k · freeAttenPerMeter^r = threshold 得 r。
 */
export function coverageRadiusMeters(power: number, wallAtten: number, threshold: number, freeAttenPerMeter: number, walls = 0): number {
  const p = Math.max(1e-6, power);
  const t = Math.min(0.999, Math.max(1e-6, threshold));
  const base = (Math.log(t / p) - walls * Math.log(Math.min(0.999, Math.max(1e-6, wallAtten)))) / Math.log(Math.min(0.999, Math.max(1e-6, freeAttenPerMeter)));
  return Math.max(0, base);
}

/** 由信号网格反推每格自由空间衰减对应的「每米衰减」，保证 UI 上的半径与实际场一致 */
export function freeAttenPerMeter(freeAtten: number, cols: number, planWidthM: number): number {
  const cellsPerMeter = cols / Math.max(0.01, planWidthM);
  return Math.pow(Math.min(0.9999, freeAtten), cellsPerMeter);
}

/* ============================ 八、Canvas 渲染层（仅页面调用） ============================ */

let scratch: HTMLCanvasElement | null = null;
function getScratch(w: number, h: number): HTMLCanvasElement {
  if (!scratch) scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  return scratch;
}

/** 热力叠加：信号场 → ImageData → 小画布 → 平滑放大到目标区域，低强度处淡出以保留图纸可读性 */
export function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  field: Float32Array,
  cols: number,
  rows: number,
  width: number,
  height: number,
  alpha = 0.62,
): void {
  const off = getScratch(cols, rows);
  const octx = off.getContext('2d');
  if (!octx) return;
  const img = octx.createImageData(cols, rows);
  const px = img.data;
  let max = 0;
  for (let i = 0; i < field.length; i += 1) if (field[i] > max) max = field[i];
  if (max <= 0) return;
  for (let i = 0; i < field.length; i += 1) {
    const [r, g, b] = heatColor(field[i] / max);
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = Math.round(255 * alpha * Math.min(1, (field[i] / max) * 2));
  }
  octx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, width, height);
  ctx.restore();
}

/** 墙线绘制（像素坐标）：厚度按比例尺换算，视觉上就是真实墙厚 */
export function drawWalls(
  ctx: CanvasRenderingContext2D,
  segs: WallSeg[],
  width: number,
  height: number,
  opts: { thicknessM: number; planWidthM: number; handles?: number[]; selected?: number },
): void {
  const pxPerM = pixelsPerMeter(width, opts.planWidthM);
  const w = Math.max(1.5, opts.thicknessM * pxPerM);
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    const x1 = s.x1 * width;
    const y1 = s.y1 * height;
    const x2 = s.x2 * width;
    const y2 = s.y2 * height;
    const sel = opts.selected === i;
    ctx.lineWidth = w;
    ctx.strokeStyle = sel ? 'rgba(255,90,60,0.95)' : 'rgba(24,24,32,0.78)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (opts.handles && opts.handles.includes(i)) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#f5320f';
      ctx.lineWidth = Math.max(1.5, w * 0.5);
      for (const [hx, hy] of [[x1, y1], [x2, y2]] as [number, number][]) {
        ctx.beginPath();
        ctx.arc(hx, hy, Math.max(5, w * 0.8), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** 每米网格叠加（比例尺参考线） */
export function drawMeterGrid(ctx: CanvasRenderingContext2D, width: number, height: number, pxPerM: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(29,53,87,.35)';
  ctx.lineWidth = 1;
  for (let x = 1; x * pxPerM < width; x += 1) {
    ctx.beginPath();
    ctx.moveTo(x * pxPerM, 0);
    ctx.lineTo(x * pxPerM, height);
    ctx.stroke();
  }
  for (let y = 1; y * pxPerM < height; y += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y * pxPerM);
    ctx.lineTo(width, y * pxPerM);
    ctx.stroke();
  }
  ctx.restore();
}

/** 等值环：每台设备的理论覆盖半径（free / 穿一墙两条虚线圈） */
export function drawSignalRings(
  ctx: CanvasRenderingContext2D,
  sources: SignalSource[],
  width: number,
  height: number,
  pxPerM: number,
  rFree: number,
  rWall: number,
): void {
  ctx.save();
  ctx.setLineDash([6, 5]);
  for (const s of sources) {
    const x = s.x * width;
    const y = s.y * height;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(29,53,87,.75)';
    ctx.beginPath();
    ctx.arc(x, y, rFree * pxPerM, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,140,40,.8)';
    ctx.beginPath();
    ctx.arc(x, y, rWall * pxPerM, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 图例条（与既有图例一致：绿=弱，红=强） */
export function drawHeatLegend(ctx: CanvasRenderingContext2D, width: number, height: number, r: number): void {
  const lw = width * 0.2;
  const lh = r * 1.2;
  const lx = width * 0.03;
  const ly = height - lh * 2.6;
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
}

export interface ExportSummary {
  title: string;
  planWidthM: number;
  planHeightM: number;
  coveredAreaM2: number;
  ratio: number;
  weakAreaM2: number;
  threshold: number;
  wallCount: number;
  sourceCount: number;
  wallAtten: number;
  generatedAt?: Date;
}

/** 导出摘要：图纸尺寸 / 覆盖率 / 图例 / 生成时间，直接烙在导出 PNG 上 */
export function drawExportSummary(ctx: CanvasRenderingContext2D, width: number, height: number, s: ExportSummary): void {
  const pad = Math.max(12, width * 0.014);
  const fs = Math.max(13, Math.round(width * 0.0135));
  const lines = [
    `${s.title}`,
    `图纸尺寸：${s.planWidthM.toFixed(2)} m × ${s.planHeightM.toFixed(2)} m（${(s.planWidthM * s.planHeightM).toFixed(1)} ㎡）`,
    `覆盖率：${(s.ratio * 100).toFixed(1)}%（强度 ≥ ${s.threshold.toFixed(2)}）`,
    `覆盖面积：${s.coveredAreaM2.toFixed(1)} ㎡　弱信号区：${s.weakAreaM2.toFixed(1)} ㎡`,
    `信号源：${s.sourceCount} 个　墙体：${s.wallCount} 道　每墙衰减：${s.wallAtten.toFixed(2)}`,
    `生成时间：${(s.generatedAt ?? new Date()).toLocaleString('zh-CN')}`,
  ];
  ctx.save();
  ctx.font = `bold ${fs}px "Microsoft YaHei", sans-serif`;
  let boxW = 0;
  for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
  const lineH = fs * 1.5;
  const boxH = lineH * lines.length + pad;
  const bx = pad;
  const by = height - boxH - pad;
  ctx.fillStyle = 'rgba(20,15,10,.74)';
  ctx.beginPath();
  ctx.roundRect(bx, by, boxW + pad * 2, boxH, fs * 0.5);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#ffd66b' : '#fff';
    ctx.font = `${i === 0 ? 'bold ' : ''}${fs}px "Microsoft YaHei", sans-serif`;
    ctx.fillText(line, bx + pad, by + pad / 2 + i * lineH);
  });
  ctx.restore();
}

export interface WifiCompositeParams {
  baseSrc: string;
  title: string;
  walls: WallSeg[];
  sources: SignalSource[];
  planWidthM: number;
  planHeightM: number;
  wallAtten: number;
  threshold: number;
  freeAtten: number;
  alpha: number;
  showGrid: boolean;
  showRings: boolean;
  wallThicknessM: number;
  targetW?: number;
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图加载失败'));
    img.src = src;
  });
}

/** 导出整图：底图 + 热力（墙衰减）+ 墙线 + 等值环 + 设备徽标 + 图例 + 导出摘要 */
export async function compositeWifiPlan(p: WifiCompositeParams): Promise<string> {
  const img = await loadHtmlImage(p.baseSrc);
  const targetW = p.targetW ?? 1600;
  const scale = Math.max(1, Math.min(3, targetW / img.naturalWidth));
  const W = Math.round(img.naturalWidth * scale);
  const H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return p.baseSrc;
  ctx.drawImage(img, 0, 0, W, H);

  const planWidthM = p.planWidthM > 0 ? p.planWidthM : 10;
  const planHeightM = p.planHeightM > 0 ? p.planHeightM : (H / Math.max(1, W)) * planWidthM;
  const { cols, rows } = fieldGrid(W, H);
  const raster = rasterizeWalls(cols, rows, p.walls, Math.round((p.wallThicknessM / planWidthM) * (cols - 1)));
  const field = computeSignalField({
    cols,
    rows,
    walls: p.walls,
    sources: p.sources,
    wallAtten: p.wallAtten,
    freeAtten: p.freeAtten,
    threshold: p.threshold,
    wallThicknessM: p.wallThicknessM,
    planWidthM,
  });
  const pxPerM = pixelsPerMeter(W, planWidthM);

  if (p.showGrid) drawMeterGrid(ctx, W, H, pxPerM);
  drawHeatmap(ctx, field, cols, rows, W, H, p.alpha);
  drawWalls(ctx, p.walls, W, H, { thicknessM: p.wallThicknessM, planWidthM });
  if (p.showRings) {
    const fam = freeAttenPerMeter(p.freeAtten, cols, planWidthM);
    const rFree = coverageRadiusMeters(1, p.wallAtten, p.threshold, fam, 0);
    const rWall = coverageRadiusMeters(1, p.wallAtten, p.threshold, fam, 1);
    drawSignalRings(ctx, p.sources, W, H, pxPerM, rFree, rWall);
  }
  const r = Math.max(12, W * 0.013);
  ctx.save();
  ctx.font = `bold ${Math.round(r * 1.1)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of p.sources) {
    const x = s.x * W;
    const y = s.y * H;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1d3557e6';
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.15);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText('W', x, y + r * 0.06);
  }
  ctx.restore();
  drawHeatLegend(ctx, W, H, r);
  const stats = measureCoverageStats(field, cols, rows, { threshold: p.threshold, planWidthM, planHeightM, wallMask: raster.cells });
  drawExportSummary(ctx, W, H, {
    title: p.title || 'WiFi 信号热力图',
    planWidthM,
    planHeightM,
    coveredAreaM2: stats.coveredAreaM2,
    ratio: stats.ratio,
    weakAreaM2: stats.weakAreaM2,
    threshold: p.threshold,
    wallCount: p.walls.length,
    sourceCount: p.sources.length,
    wallAtten: p.wallAtten,
  });
  return canvas.toDataURL('image/png');
}