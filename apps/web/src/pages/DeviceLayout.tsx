import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { App as AntApp, Button, Card, Empty, Grid, Input, InputNumber, Segmented, Slider, Space, Spin, Switch, Tag, Tooltip, Typography, Upload } from 'antd';
import { api, fileUrl } from '../lib/api';
import { loadCategoryDict } from '../lib/categoryStore';
import { compressImage } from '../lib/compress';
import { catMeta, compositePoints, compositeHeatmap, compositeLightPlan, enhanceFloorplan, loadImage } from '../lib/pointOverlay';
import {
  compositeWifiPlan,
  computeSignalField,
  coverageRadiusMeters,
  detectWalls,
  distanceToSeg,
  drawHeatmap,
  drawMeterGrid,
  drawSignalRings,
  drawWalls,
  fieldGrid,
  freeAttenPerMeter,
  measureCoverageStats,
  pixelsPerMeter,
  rasterizeWalls,
  toGray,
} from '../lib/signalHeatmap';
import type { SignalSource, WallSeg } from '../lib/signalHeatmap';
import { categoryIconSvg } from '../lib/product-icons';

const { Title, Text } = Typography;

/** 编辑器模式：设备点位（全量）/ 灯光点位 / WiFi 信号源 */
type Mode = 'device' | 'light' | 'wifi';
const MODE_CATS: Record<Mode, string[] | null> = {
  device: null,
  light: ['light'],
  wifi: ['gateway', 'network'],
};
const MODE_LABEL: Record<Mode, string> = { device: '设备点位布局', light: '灯光点位效果图', wifi: 'WiFi 信号热力图' };

/** WiFi 热力模型常量：每格自由空间衰减（<1，越远越弱）、墙厚（米，仅影响栅格化宽度与线宽） */
const WIFI_FREE_ATTEN = 0.996;
const WIFI_WALL_M = 0.12;

/**
 * 智能设备点位布局编辑器（百宝箱核心工具 + 方案空间动线页数据源）：
 * 上传户型图 → 产品库点选布点 → 拖拽微调 → 导出标注图纸 PNG + 设备清单 CSV → 可挂接到方案。
 * 点位坐标归一化 0-1，跨分辨率稳定；导出用 canvas 合成（与预览同一份数据）。
 */

interface Product {
  id: string;
  name: string;
  category: string;
  priceMin: number;
  priceMax: number;
  perRoom: string;
  brand?: string;
  model?: string;
  unit?: string;
  imageUrl?: string;
  tenantId?: string | null;
}

interface LayoutPoint {
  id: string;
  productId: string;
  name: string;
  category: string;
  /** 产品主图相对路径（有图点位显示产品照片） */
  iconUrl?: string;
  x: number;
  y: number;
}

let pointSeq = 0;
const nextPointId = (): string => `p${Date.now().toString(36)}${(pointSeq += 1)}`;

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 导出标注图纸：按模式选择合成函数 */
async function exportAnnotatedPng(baseSrc: string, points: LayoutPoint[], title: string, mode: Mode): Promise<void> {
  const fn = mode === 'wifi' ? compositeHeatmap : mode === 'light' ? compositeLightPlan : compositePoints;
  const suffix = mode === 'wifi' ? 'WiFi热力图' : mode === 'light' ? '灯光点位图' : '点位图';
  const dataUrl = await fn(baseSrc, points);
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  downloadBlob(blob, `${title || '设备点位图'}-${suffix}.png`);
}

/** 导出设备清单 CSV（BOM 兼容 Excel） */
function exportBomCsv(points: LayoutPoint[], products: Product[], title: string): void {
  const byId = new Map(products.map((p) => [p.id, p]));
  const agg = new Map<string, { name: string; category: string; qty: number; min: number; max: number }>();
  for (const p of points) {
    const prod = byId.get(p.productId);
    const key = p.productId;
    const cur = agg.get(key) ?? { name: p.name, category: catMeta(p.category).label, qty: 0, min: prod?.priceMin ?? 0, max: prod?.priceMax ?? 0 };
    cur.qty += 1;
    agg.set(key, cur);
  }
  const rows = [...agg.values()].sort((a, b) => a.category.localeCompare(b.category, 'zh') || b.qty - a.qty);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [
    [esc('设备清单'), esc(title || ''), esc(''), esc('')],
    [esc('品类'), esc('产品名称'), esc('数量'), esc('参考价区间(元)')],
    ...rows.map((r) => [esc(r.category), esc(r.name), r.qty, esc(`${r.min}-${r.max}`)]),
    [esc('合计'), esc(''), total, esc('')],
    [esc('说明'), esc('参考价仅为演示口径，实际报价以门店方案师现场确认为准'), esc(''), esc('')],
  ].join('\n');
  downloadBlob(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }), `${title || '设备清单'}-清单.csv`);
}

export function DeviceLayout(): ReactNode {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const planId = params.get('planId') ?? '';
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;

  const [products, setProducts] = useState<Product[]>([]);
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) || 'device');
  const [assetId, setAssetId] = useState('');
  const [imgSrc, setImgSrc] = useState('');
  const [points, setPoints] = useState<LayoutPoint[]>([]);
  const [pending, setPending] = useState<Product | null>(null);
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState(planId ? '方案户型点位图' : '未命名点位图');
  const [uploading, setUploading] = useState(false);
  const [beautifying, setBeautifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string } | null>(null);
  /** WiFi 叠加层画布（热力 + 墙线 + 网格 + 等值环），仅 wifi 模式挂载 */
  const wifiCanvasRef = useRef<HTMLCanvasElement>(null);
  const wallDragRef = useRef<{ kind: 'end'; index: number; end: 1 | 2 } | { kind: 'new'; x1: number; y1: number } | null>(null);

  /* ---------- WiFi 模式专属状态（device / light 模式完全不读这些字段） ---------- */
  const [walls, setWalls] = useState<WallSeg[]>([]);
  const [draftWall, setDraftWall] = useState<WallSeg | null>(null);
  const [wallTool, setWallTool] = useState<'select' | 'add'>('select');
  const [selWall, setSelWall] = useState<number | null>(null);
  const [planW, setPlanW] = useState(10);
  const [planH, setPlanH] = useState(8);
  /** 用户是否手动改过图纸尺寸：改过后不再按底图长宽比自动推算（用 ref，避免在 setState 更新函数里做副作用） */
  const sizeManualRef = useRef(false);
  const [wallAtten, setWallAtten] = useState(0.62);
  const [sigThreshold, setSigThreshold] = useState(0.18);
  const [showGrid, setShowGrid] = useState(false);
  const [showRings, setShowRings] = useState(false);
  const [powers, setPowers] = useState<Record<string, number>>({});
  const [detecting, setDetecting] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const [dictReady, setDictReady] = useState(false);

  useEffect(() => {
    void loadCategoryDict().then(() => setDictReady(true));
    api<Product[]>('/api/products').then(setProducts).catch((e) => message.error((e as Error).message));
  }, [message]);

  const grouped = useMemo(() => {
    const cats = MODE_CATS[mode];
    const map = new Map<string, Product[]>();
    for (const p of products) {
      if (cats && !cats.includes(p.category)) continue;
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()];
  }, [products, mode, dictReady]);

  const onUpload = useCallback(async (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP 户型图');
      return false;
    }
    setUploading(true);
    try {
      const compressed = await compressImage(file);
      const fd = new FormData();
      fd.append('file', compressed);
      fd.append('title', file.name.replace(/\.[^.]+$/, '').slice(0, 60));
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      setAssetId(res.id);
      setImgSrc(fileUrl(res.url));
      setPoints([]);
      setWalls([]);
      setSelWall(null);
      message.success('户型图已上传，点击右侧产品后在图上布点');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading(false);
    }
    return false;
  }, [message]);

  /** 美化当前底图：确定性增强（白底/对比度，户型不变）后重新入库替换，归一化点位不受影响 */
  const beautify = useCallback(async () => {
    if (!imgSrc) return;
    setBeautifying(true);
    try {
      const dataUrl = await enhanceFloorplan(imgSrc);
      const blob = await (await fetch(dataUrl)).blob();
      const fd = new FormData();
      fd.append('file', new File([blob], 'beautified-floorplan.png', { type: 'image/png' }));
      fd.append('title', `${title.slice(0, 50)}（美化版）`);
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      setAssetId(res.id);
      setImgSrc(fileUrl(res.url));
      message.success('图纸已美化（白底增强，户型保持不变）');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBeautifying(false);
    }
  }, [imgSrc, title, message]);

  const stagePos = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }, []);

  const onStageClick = useCallback((e: ReactMouseEvent) => {
    if (dragRef.current || wallDragRef.current) return;
    const pos = stagePos(e.clientX, e.clientY);
    if (!pos) return;
    if (pending) {
      setPoints((prev) => [...prev, { id: nextPointId(), productId: pending.id, name: pending.name, category: pending.category, iconUrl: pending.imageUrl || undefined, ...pos }]);
      setSelected('');
      return;
    }
    setSelected('');
  }, [pending, stagePos]);

  const onPointerDownPoint = useCallback((e: ReactPointerEvent, id: string) => {
    e.stopPropagation();
    setSelected(id);
    dragRef.current = { id };
    const move = (ev: PointerEvent) => {
      const pos = stagePos(ev.clientX, ev.clientY);
      if (!pos) return;
      setPoints((prev) => prev.map((p) => (p.id === id ? { ...p, ...pos } : p)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTimeout(() => { dragRef.current = null; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [stagePos]);

  /* ================= WiFi 模式：墙体 / 信号场 / 覆盖率 ================= */

  // 底图原始像素尺寸：比例尺与信号网格规模都由它推导
  useEffect(() => {
    if (!imgSrc) {
      setImgSize(null);
      return;
    }
    let alive = true;
    void loadImage(imgSrc)
      .then((img) => {
        if (!alive) return;
        setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
        // 用户没手动改过尺寸时，按底图长宽比推一个图纸高度，避免比例尺与等值环被拉成椭圆
        if (!sizeManualRef.current) {
          const ratio = img.naturalHeight / Math.max(1, img.naturalWidth);
          setPlanH(Math.max(0.5, Math.round(10 * ratio * 100) / 100));
        }
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [imgSrc]);

  const wifiSources = useMemo<SignalSource[]>(
    () => points.map((p) => ({ x: p.x, y: p.y, power: powers[p.id] ?? 1 })),
    [points, powers],
  );

  /** 信号网格规模：限制总格数，保证拖墙/拖设备时能实时重算 */
  const grid = useMemo(() => (imgSize ? fieldGrid(imgSize.w, imgSize.h) : null), [imgSize]);

  /** 墙衰减信号场：网格洪水填充，遇墙按 wallAtten 逐道衰减 */
  const field = useMemo(() => {
    if (mode !== 'wifi' || !grid || !wifiSources.length) return null;
    return computeSignalField({
      cols: grid.cols,
      rows: grid.rows,
      walls,
      sources: wifiSources,
      wallAtten,
      freeAtten: WIFI_FREE_ATTEN,
      threshold: sigThreshold,
      wallThicknessM: WIFI_WALL_M,
      planWidthM: planW,
    });
  }, [mode, grid, wifiSources, walls, wallAtten, sigThreshold, planW]);

  /** 覆盖率统计：强度 ≥ 阈值的格子占比，墙格不计入图纸面积 */
  const stats = useMemo(() => {
    if (!field || !grid) return null;
    const raster = rasterizeWalls(grid.cols, grid.rows, walls, Math.round((WIFI_WALL_M / Math.max(0.01, planW)) * (grid.cols - 1)));
    return measureCoverageStats(field, grid.cols, grid.rows, {
      threshold: sigThreshold,
      planWidthM: planW,
      planHeightM: planH,
      wallMask: raster.cells,
    });
  }, [field, grid, walls, sigThreshold, planW, planH]);

  /** 理论覆盖半径（米）：空场 / 穿一墙 */
  const radii = useMemo(() => {
    if (!grid) return { free: 0, wall: 0 };
    const perMeter = freeAttenPerMeter(WIFI_FREE_ATTEN, grid.cols, planW);
    return {
      free: coverageRadiusMeters(1, wallAtten, sigThreshold, perMeter, 0),
      wall: coverageRadiusMeters(1, wallAtten, sigThreshold, perMeter, 1),
    };
  }, [grid, planW, wallAtten, sigThreshold]);

  /** 叠加层重绘（rAF 节流：拖墙/拖设备每帧最多画一次） */
  const drawWifiOverlay = useCallback(() => {
    const canvas = wifiCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pxPerM = pixelsPerMeter(W, planW);
    if (showGrid) drawMeterGrid(ctx, W, H, pxPerM);
    if (field && grid) drawHeatmap(ctx, field, grid.cols, grid.rows, W, H, 0.6);
    if (showRings) drawSignalRings(ctx, wifiSources, W, H, pxPerM, radii.free, radii.wall);
    drawWalls(ctx, draftWall ? [...walls, draftWall] : walls, W, H, {
      thicknessM: WIFI_WALL_M,
      planWidthM: planW,
      handles: selWall != null ? [selWall] : undefined,
      selected: selWall ?? undefined,
    });
  }, [planW, showGrid, field, grid, showRings, wifiSources, radii, walls, draftWall, selWall]);

  useEffect(() => {
    if (mode !== 'wifi' || !imgSize) return;
    const canvas = wifiCanvasRef.current;
    if (!canvas) return;
    const w = Math.min(1600, imgSize.w);
    const h = Math.max(1, Math.round(w * imgSize.h / imgSize.w));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const raf = requestAnimationFrame(drawWifiOverlay);
    return () => cancelAnimationFrame(raf);
  }, [mode, imgSize, drawWifiOverlay]);

  /** 墙体识别：确定性纯前端 CV（Otsu + 距离变换 + 连通域 + 游程 + 双线合并），不调任何 AI 接口 */
  const runWallDetection = useCallback(async () => {
    if (!imgSrc) return;
    setDetecting(true);
    try {
      await new Promise((r) => { setTimeout(r, 0); });
      const img = await loadImage(imgSrc);
      const aw = 1000;
      const ah = Math.max(1, Math.round(aw * img.naturalHeight / img.naturalWidth));
      const c = document.createElement('canvas');
      c.width = aw;
      c.height = ah;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('当前浏览器不支持画布像素读取');
      ctx.drawImage(img, 0, 0, aw, ah);
      const gray = toGray(ctx.getImageData(0, 0, aw, ah).data, aw, ah);
      const res = detectWalls(gray);
      setWalls(res.segments);
      setSelWall(null);
      if (res.segments.length) {
        message.success(`识别到 ${res.segments.length} 道墙（Otsu 阈值 ${res.threshold}，分离度 ${(res.separation * 100).toFixed(0)}%）。可拖端点改方向、点墙身选中后删除，或用「新增墙」补画`);
      } else {
        message.warning('未识别到墙体：请确认图纸是清晰的深线白底图，或用「新增墙」手动画线');
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }, [imgSrc, message]);

  /** 叠加层上的墙交互：端点拖拽 / 墙身选中 / 拉出新墙；未命中时不拦截冒泡，交给 stage 正常布点 */
  const onCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;

    if (wallTool === 'add') {
      wallDragRef.current = { kind: 'new', x1: px, y1: py };
      setSelWall(null);
      setDraftWall({ x1: px, y1: py, x2: px, y2: py });
      const move = (ev: PointerEvent) => {
        const p = stagePos(ev.clientX, ev.clientY);
        if (p) setDraftWall({ x1: px, y1: py, x2: p.x, y2: p.y });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setDraftWall((cur) => {
          if (cur && Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) > 0.01) setWalls((prev) => [...prev, cur]);
          return null;
        });
        setTimeout(() => { wallDragRef.current = null; }, 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    // 端点优先（12px 命中半径），命中即拖拽改方向
    const ep = 12 / rect.width;
    let best: { index: number; end: 1 | 2; d: number } | undefined;
    for (let i = 0; i < walls.length; i += 1) {
      const w = walls[i];
      const d1 = Math.hypot(w.x1 - px, w.y1 - py);
      const d2 = Math.hypot(w.x2 - px, w.y2 - py);
      const d = Math.min(d1, d2);
      if (d < ep && (best === undefined || d < best.d)) best = { index: i, end: d1 <= d2 ? 1 : 2, d };
    }
    const hit = best;
    if (hit) {
      setSelWall(hit.index);
      wallDragRef.current = { kind: 'end', index: hit.index, end: hit.end };
      const move = (ev: PointerEvent) => {
        const p = stagePos(ev.clientX, ev.clientY);
        if (!p) return;
        setWalls((prev) => prev.map((w, i) => (i === hit.index ? (hit.end === 1 ? { ...w, x1: p.x, y1: p.y } : { ...w, x2: p.x, y2: p.y }) : w)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setTimeout(() => { wallDragRef.current = null; }, 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    // 墙身：只选中不拖拽
    const hitSeg = 8 / rect.width;
    const idx = walls.findIndex((w) => distanceToSeg(w, px, py) < hitSeg);
    if (idx >= 0) {
      setSelWall(idx);
      wallDragRef.current = { kind: 'end', index: idx, end: 1 };
      setTimeout(() => { wallDragRef.current = null; }, 0);
      return;
    }
    setSelWall(null);
  }, [wallTool, walls, stagePos]);

  /** 导出带墙体与摘要的热力图 PNG */
  const exportWifiPng = useCallback(async () => {
    if (!imgSrc) return;
    try {
      const dataUrl = await compositeWifiPlan({
        baseSrc: imgSrc,
        title: title || 'WiFi 信号热力图',
        walls,
        sources: wifiSources,
        planWidthM: planW,
        planHeightM: planH,
        wallAtten,
        threshold: sigThreshold,
        freeAtten: WIFI_FREE_ATTEN,
        alpha: 0.62,
        showGrid,
        showRings,
        wallThicknessM: WIFI_WALL_M,
        targetW: 1600,
      });
      const blob = await (await fetch(dataUrl)).blob();
      downloadBlob(blob, `${title || 'WiFi热力图'}-WiFi热力图.png`);
      message.success('已导出含墙体、覆盖率摘要与图例的热力图');
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [imgSrc, title, walls, wifiSources, planW, planH, wallAtten, sigThreshold, showGrid, showRings, message]);

  const saveAndAttach = useCallback(async () => {
    if (!assetId) {
      message.warning('请先上传户型图');
      return;
    }
    if (!points.length) {
      message.warning('还没有任何点位');
      return;
    }
    setSaving(true);
    try {
      const dto = {
        title,
        mediaAssetId: assetId,
        points: points.map(({ productId, name, category, iconUrl, x, y }) => ({ productId, name, category, ...(iconUrl ? { iconUrl } : {}), x: +x.toFixed(4), y: +y.toFixed(4) })),
      };
      await api('/api/layouts', { method: 'POST', body: JSON.stringify(dto) });
      if (planId) {
        await api(`/api/plans/${planId}/floorplan`, { method: 'PATCH', body: JSON.stringify({ floorplanAssetId: assetId, layoutPoints: dto.points }) });
        message.success('点位图已挂接到方案，返回方案页查看');
        navigate(`/plan?id=${planId}`);
      } else {
        message.success('点位图已保存');
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [assetId, points, planId, title, message, navigate]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of points) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [points]);

  return (
    <div style={{ width: '100%', paddingBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <Title level={3} style={{ marginBottom: 4 }}>{MODE_LABEL[mode]}</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            上传户型平面图，从产品库点选设备布点，拖拽微调位置，导出标注图纸与设备清单{planId ? '，并挂接到当前方案的空间动线页' : ''}。
          </Text>
        </div>
        <Space>
          <Segmented
            value={mode}
            onChange={(v) => { setMode(v as Mode); setPending(null); }}
            options={[
              { label: '设备点位', value: 'device' },
              { label: '灯光点位', value: 'light' },
              { label: 'WiFi 热力', value: 'wifi' },
            ]}
          />
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} style={{ width: 220 }} prefix={<Text type="secondary" style={{ fontSize: 12 }}>图纸名</Text>} />
          {planId && <Button onClick={() => navigate(`/plan?id=${planId}`)}>返回方案</Button>}
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 画布 */}
        <Card
          style={{ flex: '1 1 560px', minWidth: 320 }}
          styles={{ body: { padding: 16 } }}
          title={
            <Space>
              <Upload accept="image/jpeg,image/png,image/webp" showUploadList={false} beforeUpload={onUpload}>
                <Button type="primary" ghost loading={uploading} size="small">上传户型图</Button>
              </Upload>
              {imgSrc && (
                <>
                  <Button size="small" loading={beautifying} onClick={() => void beautify()}>美化图纸</Button>
                  {mode === 'wifi' ? (
                    <Button size="small" onClick={() => void exportWifiPng()}>导出热力图 PNG</Button>
                  ) : (
                    <Button size="small" onClick={() => void exportAnnotatedPng(imgSrc, points, title, mode)}>导出标注图纸 PNG</Button>
                  )}
                  {mode === 'device' && <Button size="small" onClick={() => exportBomCsv(points, products, title)}>导出设备清单 CSV</Button>}
                  {mode === 'device' && <Button size="small" type="primary" loading={saving} onClick={() => void saveAndAttach()}>{planId ? '保存并挂接方案' : '保存图纸'}</Button>}
                </>
              )}
            </Space>
          }
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{pending ? `布点中：${pending.name}（点击画布放置，Esc 取消）` : `已布 ${points.length} 个点位`}</Text>}
        >
          {!imgSrc ? (
            <Spin spinning={uploading}>
              <Empty description={<span>上传客户户型平面图开始布点<br /><Text type="secondary" style={{ fontSize: 12 }}>支持 JPG / PNG / WebP，10MB 内</Text></span>} style={{ padding: '64px 0' }} />
            </Spin>
          ) : (
            <div
              ref={stageRef}
              onClick={onStageClick}
              onKeyDown={(e) => { if (e.key === 'Escape') setPending(null); }}
              tabIndex={0}
              style={{ position: 'relative', cursor: pending ? 'crosshair' : 'default', userSelect: 'none', outline: 'none', borderRadius: 8, overflow: 'hidden' }}
            >
              <img src={imgSrc} alt="户型平面图" draggable={false} style={{ display: 'block', width: '100%' }} />
              {/* WiFi 叠加层：热力 + 墙线 + 每米网格 + 等值环；压在底图之上、点位之下，故点位拖拽不受影响 */}
              {mode === 'wifi' && (
                <canvas
                  ref={wifiCanvasRef}
                  onPointerDown={onCanvasPointerDown}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1, cursor: wallTool === 'add' ? 'crosshair' : 'default', touchAction: 'none' }}
                />
              )}
              {points.map((p) => {
                const m = catMeta(p.category);
                const isSel = selected === p.id;
                return (
                  <div
                    key={p.id}
                    onPointerDown={(e) => onPointerDownPoint(e, p.id)}
                    style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%,-50%)', cursor: 'grab', zIndex: isSel ? 3 : 2 }}
                  >
                    <Tooltip title={`${p.name}（拖动调整位置，选中后按 Delete 或点右侧删除）`}>
                      {p.iconUrl ? (
                        <img
                          src={fileUrl(p.iconUrl)}
                          alt={p.name}
                          draggable={false}
                          style={{ width: isSel ? 32 : 26, height: isSel ? 32 : 26, borderRadius: '50%', objectFit: 'cover', background: '#fff', border: `2px solid ${m.color}`, boxShadow: '0 2px 6px rgba(0,0,0,.35)', display: 'block' }}
                        />
                      ) : (
                        <div style={{ width: isSel ? 32 : 26, height: isSel ? 32 : 26, borderRadius: '50%', background: m.color, border: '2px solid #fff', boxShadow: '0 2px 6px rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ display: 'inline-flex', color: '#fff', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: categoryIconSvg(p.category, isSel ? 20 : 16, '#ffffff') }} />
                        </div>
                      )}
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* 右侧栏：WiFi 参数面板 + 产品库（窄屏时整列落到画布下方） */}
        <div style={{ width: isWide ? 320 : '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {mode === 'wifi' && (
          <Card size="small" title={<Text strong style={{ fontSize: 13 }}>WiFi 热力参数</Text>} styles={{ body: { padding: 12 } }}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>图纸实际尺寸（米，决定比例尺与覆盖面积）</Text>
                <Space size={8} style={{ marginTop: 4 }}>
                  <InputNumber value={planW} min={0.5} max={500} step={0.5} addonBefore="宽" onChange={(v) => { sizeManualRef.current = true; setPlanW(Number(v) > 0 ? Number(v) : 10); }} style={{ width: 112 }} />
                  <InputNumber value={planH} min={0.5} max={500} step={0.5} addonBefore="高" onChange={(v) => { sizeManualRef.current = true; setPlanH(Number(v) > 0 ? Number(v) : 8); }} style={{ width: 112 }} />
                </Space>
              </div>

              <div>
                <Space size={8} wrap>
                  <Button size="small" type="primary" ghost loading={detecting} onClick={() => void runWallDetection()}>识别墙体</Button>
                  <Button size="small" disabled={!walls.length} onClick={() => { setWalls([]); setSelWall(null); }}>清空墙体</Button>
                </Space>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  已识别 {walls.length} 道墙。拖墙端点可改方向，点墙身选中后可删除；识别不准就用「新增墙」补画。
                </Text>
              </div>

              <Segmented
                size="small"
                block
                value={wallTool}
                onChange={(v) => setWallTool(v as 'select' | 'add')}
                options={[{ label: '选择 / 拖端点', value: 'select' }, { label: '新增墙', value: 'add' }]}
              />

              {selWall != null && (
                <Button size="small" danger block onClick={() => { setWalls((prev) => prev.filter((_, i) => i !== selWall)); setSelWall(null); }}>
                  删除选中的墙（第 {selWall + 1} 道）
                </Button>
              )}

              <div>
                <Text style={{ fontSize: 12 }}>每墙衰减系数 <b>{wallAtten.toFixed(2)}</b></Text>
                <Slider min={0.1} max={0.95} step={0.01} value={wallAtten} onChange={setWallAtten} />
              </div>

              <div>
                <Text style={{ fontSize: 12 }}>有效信号阈值 <b>{sigThreshold.toFixed(2)}</b></Text>
                <Slider min={0.05} max={0.9} step={0.01} value={sigThreshold} onChange={setSigThreshold} />
              </div>

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={8}><Switch size="small" checked={showRings} onChange={setShowRings} /><Text style={{ fontSize: 12 }}>显示覆盖半径等值环</Text></Space>
                <Space size={8}><Switch size="small" checked={showGrid} onChange={setShowGrid} /><Text style={{ fontSize: 12 }}>叠加每米网格（比例尺）</Text></Space>
              </Space>

              <div style={{ borderTop: '1px solid rgba(0,0,0,.06)', paddingTop: 8 }}>
                <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>覆盖率统计</Text>
                {stats ? (
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div>图纸尺寸：{planW} × {planH} m（{stats.planAreaM2.toFixed(1)} ㎡）</div>
                    <div>覆盖面积：{stats.coveredAreaM2.toFixed(1)} ㎡</div>
                    <div>
                      覆盖率：
                      <b style={{ color: stats.ratio > 0.7 ? '#389e0d' : stats.ratio > 0.4 ? '#d48806' : '#cf1322' }}>
                        {(stats.ratio * 100).toFixed(1)}%
                      </b>
                    </div>
                    <div>弱信号区：{stats.weakAreaM2.toFixed(1)} ㎡</div>
                    {wifiSources.length > 0 && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        理论覆盖半径：空场 {radii.free.toFixed(1)} m，穿一墙 {radii.wall.toFixed(1)} m
                      </Text>
                    )}
                  </div>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>放置网关 / AP 后自动统计</Text>
                )}
              </div>

              {selected && (
                <div>
                  <Text style={{ fontSize: 12 }}>选中设备发射功率 <b>{(powers[selected] ?? 1).toFixed(2)}</b></Text>
                  <Slider min={0.2} max={2} step={0.05} value={powers[selected] ?? 1} onChange={(v) => setPowers((prev) => ({ ...prev, [selected]: v }))} />
                </div>
              )}
            </Space>
          </Card>
        )}

        {/* 产品面板 */}
        <Card style={{ width: '100%' }} styles={{ body: { padding: '12px 16px', maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }}>
          <Text strong style={{ fontSize: 14 }}>产品库</Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>点击产品进入布点模式，再点画布放置</Text>
          {grouped.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 12 }}>
              <Tag color={catMeta(cat).color} style={{ marginBottom: 6 }}>{catMeta(cat).label} · {counts.get(cat) ?? 0} 已布</Tag>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {list.map((p) => (
                  <Button
                    key={p.id}
                    block
                    size="small"
                    type={pending?.id === p.id ? 'primary' : 'default'}
                    style={{ textAlign: 'left', height: 'auto', padding: '4px 10px', whiteSpace: 'normal' }}
                    onClick={() => setPending((cur) => (cur?.id === p.id ? null : p))}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ display: 'inline-flex', color: catMeta(p.category).color, lineHeight: 0, flex: 'none' }} dangerouslySetInnerHTML={{ __html: categoryIconSvg(p.category, 16, catMeta(p.category).color) }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                        <div style={{ fontSize: 11, opacity: 0.65 }}>{p.perRoom || '按需布置'} · 参考 ¥{p.priceMin}-{p.priceMax}</div>
                      </div>
                    </div>
                  </Button>
                ))}
              </Space>
            </div>
          ))}
          {selected && (
            <Space style={{ marginTop: 4 }}>
              <Button danger size="small" onClick={() => { setPoints((prev) => prev.filter((x) => x.id !== selected)); setSelected(''); }}>删除选中的点位</Button>
            </Space>
          )}
          {points.length > 0 && (
            <Button size="small" style={{ marginTop: 8 }} onClick={() => { setPoints([]); setSelected(''); }}>清空全部点位</Button>
          )}
        </Card>
        </div>
      </div>
    </div>
  );
}
