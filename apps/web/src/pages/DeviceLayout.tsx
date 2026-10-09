import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { App as AntApp, Button, Card, Empty, Input, Segmented, Space, Spin, Tag, Tooltip, Typography, Upload } from 'antd';
import { api, fileUrl } from '../lib/api';
import { catMeta, compositePoints, compositeHeatmap, compositeLightPlan, enhanceFloorplan } from '../lib/pointOverlay';
import { categoryIconSvg } from '../lib/product-icons';

const { Title, Text } = Typography;

/** 编辑器模式：设备点位（全量）/ 灯光点位 / WiFi 信号源 */
type Mode = 'device' | 'light' | 'wifi';
const MODE_CATS: Record<Mode, string[] | null> = {
  device: null,
  light: ['light'],
  wifi: ['gateway'],
};
const MODE_LABEL: Record<Mode, string> = { device: '设备点位布局', light: '灯光点位效果图', wifi: 'WiFi 信号热力图' };

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

  useEffect(() => {
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
  }, [products, mode]);

  const onUpload = useCallback(async (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP 户型图');
      return false;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', file.name.replace(/\.[^.]+$/, '').slice(0, 60));
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      setAssetId(res.id);
      setImgSrc(fileUrl(res.url));
      setPoints([]);
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
    if (dragRef.current) return;
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
                  <Button size="small" onClick={() => void exportAnnotatedPng(imgSrc, points, title, mode)}>导出标注图纸 PNG</Button>
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

        {/* 产品面板 */}
        <Card style={{ width: 320, flexShrink: 0 }} styles={{ body: { padding: '12px 16px', maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }}>
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
  );
}
