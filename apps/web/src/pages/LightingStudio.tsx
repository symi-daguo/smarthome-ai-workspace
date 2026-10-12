import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { App as AntApp, Button, Card, Empty, Form, Grid, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Slider, Space, Steps, Switch, Tag, Tooltip, Typography, Upload } from 'antd';
import { InboxOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api, fileUrl } from '../lib/api';
import { compressImage } from '../lib/compress';
import { PageHeader } from '../components/PageHeader';
import { pageContainerStyle } from '../theme/tokens';

const { Text } = Typography;

/**
 * 智能灯光场景演示（百宝箱「方案与设计」工具）：
 *   ① 上传效果图 + 选画幅 → ② 编排灯具（拖动移位 / 改类型 / 增删 / 设常暗）
 *   → ③ 手工灯光时间轴（每盏灯一条轨道、关键帧调亮度与色温）→ ④ 出片。
 *
 * 灯具坐标归一化 0-1，跨分辨率稳定；时间轴是关键帧插值，
 * 预览与出片共用同一份 fixtures + timeline，不存在「预览一套、出片另一套」。
 */

type FixtureType = 'ceiling' | 'spot' | 'strip' | 'floor' | 'table';

interface Fixture {
  id: string;
  type: FixtureType;
  name: string;
  /** 归一化 0-1 */
  x: number;
  y: number;
  /** 基准亮度 0-100 */
  brightness: number;
  /** 色温 2200-6500K */
  colorTemp: number;
  /** 常暗：不参与时间轴，始终保持最低亮度 */
  alwaysDim: boolean;
  order: number;
}

interface Keyframe {
  /** 0-1 相对片长位置 */
  t: number;
  brightness: number;
  colorTemp: number;
}

interface Track {
  fixtureId: string;
  keyframes: Keyframe[];
}

interface Timeline {
  /** 片长秒 */
  durationSec: number;
  tracks: Track[];
}

interface SceneRow {
  id: string;
  title: string;
  ratio: string;
  status: string;
  videoAssetId: string | null;
  createdAt: string;
}

const TYPES: { value: FixtureType; label: string; size: number }[] = [
  { value: 'ceiling', label: '吸顶灯', size: 120 },
  { value: 'spot', label: '射灯', size: 74 },
  { value: 'strip', label: '灯带', size: 150 },
  { value: 'floor', label: '落地灯', size: 96 },
  { value: 'table', label: '台灯', size: 66 },
];
const TYPE_LABEL: Record<FixtureType, string> = Object.fromEntries(TYPES.map((t) => [t.value, t.label])) as Record<FixtureType, string>;
const TYPE_SIZE: Record<FixtureType, number> = Object.fromEntries(TYPES.map((t) => [t.value, t.size])) as Record<FixtureType, number>;

const RATIOS = ['16:9', '9:16', '1:1'] as const;

/** 色温近似 RGB（够用的视觉映射，不追求物理精确） */
function kelvinToRgb(k: number): string {
  const stops: [number, [number, number, number]][] = [
    [2200, [255, 138, 60]],
    [2700, [255, 171, 87]],
    [3200, [255, 196, 126]],
    [4000, [255, 222, 180]],
    [5000, [255, 238, 219]],
    [6500, [255, 247, 238]],
  ];
  if (k <= stops[0][0]) return `rgb(${stops[0][1].join(',')})`;
  if (k >= stops[stops.length - 1][0]) return `rgb(${stops[stops.length - 1][1].join(',')})`;
  for (let i = 1; i < stops.length; i += 1) {
    if (k <= stops[i][0]) {
      const [k0, c0] = stops[i - 1];
      const [k1, c1] = stops[i];
      const f = (k - k0) / (k1 - k0);
      const mix = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
      return `rgb(${mix.join(',')})`;
    }
  }
  return 'rgb(255,238,219)';
}

let seq = 0;
const nextId = (): string => `fx${Date.now().toString(36)}${(seq += 1)}`;

function makeFixture(type: FixtureType, x: number, y: number, order: number): Fixture {
  return { id: nextId(), type, name: `${TYPE_LABEL[type]}${order}`, x, y, brightness: 80, colorTemp: 3500, alwaysDim: false, order };
}

/** 在 t 时刻线性插值某灯具的亮度与色温（关键帧区间外取端点值） */
function sampleAt(track: Track | undefined, t: number, fixture: Fixture): { brightness: number; colorTemp: number } {
  if (fixture.alwaysDim) return { brightness: 8, colorTemp: fixture.colorTemp };
  const kfs = track?.keyframes ?? [];
  if (kfs.length === 0) return { brightness: fixture.brightness, colorTemp: fixture.colorTemp };
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  if (t <= sorted[0].t) return { brightness: sorted[0].brightness, colorTemp: sorted[0].colorTemp };
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return { brightness: last.brightness, colorTemp: last.colorTemp };
  for (let i = 1; i < sorted.length; i += 1) {
    if (t <= sorted[i].t) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const span = b.t - a.t;
      const f = span === 0 ? 0 : (t - a.t) / span;
      return { brightness: Math.round(a.brightness + (b.brightness - a.brightness) * f), colorTemp: Math.round(a.colorTemp + (b.colorTemp - a.colorTemp) * f) };
    }
  }
  return { brightness: last.brightness, colorTemp: last.colorTemp };
}

/** 把编排结果翻译成给视频模型的画面描述（出片真正消费的是这段文本） */
function buildVideoPrompt(fixtures: Fixture[], timeline: Timeline): string {
  if (fixtures.length === 0) return '室内智能灯光场景，灯光柔和自然，画面稳定无抖动。';
  const ordered = [...fixtures].sort((a, b) => a.order - b.order);
  const parts = ordered.map((f, i) => {
    const track = timeline.tracks.find((x) => x.fixtureId === f.id);
    const kfs = [...(track?.keyframes ?? [])].sort((a, b) => a.t - b.t);
    if (f.alwaysDim) return `${i + 1}) ${f.name}（${TYPE_LABEL[f.type]}）保持常暗微光`;
    if (kfs.length === 0) return `${i + 1}) ${f.name}（${TYPE_LABEL[f.type]}）全程维持 ${f.brightness}% 亮度、${f.colorTemp}K 色温`;
    const seg = kfs.map((k, idx) => `第 ${(k.t * timeline.durationSec).toFixed(1)} 秒${idx < kfs.length - 1 ? '起' : ''}亮度 ${k.brightness}%、色温 ${k.colorTemp}K`).join('，');
    return `${i + 1}) ${f.name}（${TYPE_LABEL[f.type]}）：${seg}`;
  });
  return `室内智能灯光场景演示，真实室内摄影质感，画面稳定，机位固定。灯光变化按以下编排依次发生：${parts.join('；')}。整体节奏自然，灯光过渡平滑无闪烁。`;
}

export function LightingStudio(): ReactNode {
  const { message } = AntApp.useApp();
  // 窄屏（平板竖屏 / 手机）把并排的编辑面板改为上下堆叠
  const screens = Grid.useBreakpoint();
  const stacked = !(screens.lg ?? false);
  const [step, setStep] = useState(0);
  const [ratio, setRatio] = useState<string>('16:9');
  const [title, setTitle] = useState('灯光场景演示');
  const [assetId, setAssetId] = useState('');
  const [imgSrc, setImgSrc] = useState('');
  const [uploading, setUploading] = useState(false);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selected, setSelected] = useState('');
  const [durationSec, setDurationSec] = useState(6);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [sceneId, setSceneId] = useState('');
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string } | null>(null);
  const kfDragRef = useRef<{ fixtureId: string; index: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  const aspect = ratio === '9:16' ? '9 / 16' : ratio === '1:1' ? '1 / 1' : '16 / 9';
  const timeline: Timeline = useMemo(() => ({ durationSec, tracks }), [durationSec, tracks]);

  const loadScenes = useCallback(async () => {
    try {
      setScenes(await api<SceneRow[]>('/api/lighting'));
    } catch {
      setScenes([]);
    }
  }, []);

  useEffect(() => {
    void loadScenes();
  }, [loadScenes]);

  // 每盏灯的轨道按需补齐；灯具删除时同步清理轨道
  useEffect(() => {
    setTracks((prev) => {
      const ids = new Set(fixtures.map((f) => f.id));
      const kept = prev.filter((t) => ids.has(t.fixtureId));
      const missing = fixtures
        .filter((f) => !kept.some((t) => t.fixtureId === f.id))
        .map<Track>((f) => ({
          fixtureId: f.id,
          keyframes: [
            { t: 0, brightness: f.brightness, colorTemp: f.colorTemp },
            { t: 1, brightness: f.brightness, colorTemp: f.colorTemp },
          ],
        }));
      return missing.length || kept.length !== prev.length ? [...kept, ...missing] : prev;
    });
  }, [fixtures]);

  // 播放预览
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((p) => {
        const next = p + dt / durationSec;
        if (next >= 1) {
          setPlaying(false);
          return 1;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, durationSec]);

  // ---------- 灯具编排 ----------
  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!imgSrc || step !== 1) return;
    const type = (e.nativeEvent as unknown as { fixtureType?: FixtureType }).fixtureType;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (type) {
      const fx = makeFixture(type, Math.min(0.98, Math.max(0.02, x)), Math.min(0.98, Math.max(0.02, y)), fixtures.length + 1);
      setFixtures((prev) => [...prev, fx]);
      setSelected(fx.id);
      return;
    }
    const hit = fixtures.find((f) => {
      const dx = (x - f.x) * rect.width;
      const dy = (y - f.y) * rect.height;
      return Math.hypot(dx, dy) <= TYPE_SIZE[f.type] / 2 + 6;
    });
    if (hit) {
      setSelected(hit.id);
      dragRef.current = { id: hit.id };
    } else {
      setSelected('');
    }
  };

  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const id = dragRef.current?.id;
    if (!id) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setFixtures((prev) => prev.map((f) => (f.id === id ? { ...f, x: Math.min(0.98, Math.max(0.02, x)), y: Math.min(0.98, Math.max(0.02, y)) } : f)));
  };

  const patchFixture = (id: string, patch: Partial<Fixture>): void => {
    setFixtures((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeFixture = (id: string): void => {
    setFixtures((prev) => prev.filter((f) => f.id !== id));
    setTracks((prev) => prev.filter((t) => t.fixtureId !== id));
    if (selected === id) setSelected('');
  };

  const moveFixture = (id: string, dir: -1 | 1): void => {
    setFixtures((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((f) => f.id === id);
      const swap = idx + dir;
      if (idx < 0 || swap < 0 || swap >= sorted.length) return prev;
      [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
      return sorted.map((f, i) => ({ ...f, order: i + 1, name: f.name.replace(/(\D+)\d*$/, `$1${i + 1}`) }));
    });
  };

  // ---------- 时间轴 ----------
  const patchTrack = (fixtureId: string, fn: (t: Track) => Track): void => {
    setTracks((prev) => prev.map((t) => (t.fixtureId === fixtureId ? fn(t) : t)));
  };

  /** 在 t 时刻添加关键帧：亮度与色温沿用该时刻的插值结果，避免跳变 */
  const addKeyframe = (fixtureId: string, t: number): void => {
    const fixture = fixtures.find((f) => f.id === fixtureId);
    if (!fixture) return;
    const track = tracks.find((x) => x.fixtureId === fixtureId);
    const at = Math.min(1, Math.max(0, t));
    const sampled = sampleAt(track, at, fixture);
    setTracks((prev) => {
      const exist = prev.find((x) => x.fixtureId === fixtureId);
      const base = exist ? [...exist.keyframes] : [];
      // 同一时刻只允许一个关键帧，重叠则覆盖
      const kfs = base.filter((k) => Math.abs(k.t - at) > 0.02);
      kfs.push({ t: at, brightness: sampled.brightness, colorTemp: sampled.colorTemp });
      const next = { fixtureId, keyframes: kfs.sort((a, b) => a.t - b.t) };
      return exist ? prev.map((x) => (x.fixtureId === fixtureId ? next : x)) : [...prev, next];
    });
    setPlayhead(at);
  };

  const updateKeyframe = (fixtureId: string, index: number, patch: Partial<Keyframe>): void => {
    patchTrack(fixtureId, (track) => {
      const kfs = [...track.keyframes];
      if (!kfs[index]) return track;
      kfs[index] = { ...kfs[index], ...patch };
      return { fixtureId, keyframes: kfs.sort((a, b) => a.t - b.t) };
    });
  };

  const removeKeyframe = (fixtureId: string, index: number): void => {
    patchTrack(fixtureId, (track) => ({ fixtureId, keyframes: track.keyframes.filter((_, i) => i !== index) }));
  };

  /** 轨道交互：拖动关键帧改时间；点击空白处在该时刻新增关键帧（并同步播放头） */
  const onTimelinePointerDown = (e: ReactPointerEvent<HTMLDivElement>, fixtureId: string): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const kf = kfDragRef.current;
    if (kf) {
      updateKeyframe(kf.fixtureId, kf.index, { t });
      setPlayhead(t);
      return;
    }
    setSelected(fixtureId);
    addKeyframe(fixtureId, t);
  };

  // ---------- 保存 / 出片 ----------
  const persist = async (): Promise<string> => {
    const payload = { title, sourceAssetId: assetId || undefined, ratio, fixtures, timeline };
    if (sceneId) {
      await api(`/api/lighting/${sceneId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      return sceneId;
    }
    const created = await api<{ id: string }>('/api/lighting', { method: 'POST', body: JSON.stringify(payload) });
    setSceneId(created.id);
    void loadScenes();
    return created.id;
  };

  const generate = async (): Promise<void> => {
    if (!assetId) {
      message.warning('请先上传参考效果图');
      return;
    }
    if (fixtures.length === 0) {
      message.warning('请至少编排一盏灯');
      return;
    }
    setRendering(true);
    try {
      const id = await persist();
      const r = await api<{ url: string }>('/api/media/videos', {
        method: 'POST',
        body: JSON.stringify({ prompt: buildVideoPrompt(fixtures, timeline), firstFrameAssetId: assetId, durationSec }),
      });
      await api(`/api/lighting/${id}`, { method: 'PATCH', body: JSON.stringify({ videoAssetId: r.url, status: 'ready' }) });
      setVideoUrl(fileUrl(`${r.url}?t=${Date.now()}`));
      void loadScenes();
      message.success('灯光场景视频已生成并保存到「我的资料库」');
      setStep(3);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '出片失败');
    } finally {
      setRendering(false);
    }
  };

  const openScene = async (id: string): Promise<void> => {
    try {
      const s = await api<{ id: string; title: string; ratio: string; sourceAssetId: string | null; fixtures: Fixture[]; timeline: Timeline; status: string; videoAssetId: string | null }>(`/api/lighting/${id}`);
      setSceneId(s.id);
      setTitle(s.title);
      setRatio(s.ratio);
      setAssetId(s.sourceAssetId ?? '');
      setImgSrc(s.sourceAssetId ? fileUrl(`/api/media/assets/${s.sourceAssetId}/file`) : '');
      setFixtures(s.fixtures);
      setTimelineSafe(s.timeline);
      setStep(s.fixtures.length > 0 ? 2 : 1);
      setHistoryOpen(false);
      message.success(`已载入「${s.title}」`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '载入失败');
    }
  };

  const setTimelineSafe = (t: Timeline): void => {
    setDurationSec(t.durationSec || 6);
    setTracks(Array.isArray(t.tracks) ? t.tracks : []);
  };

  const removeScene = async (id: string): Promise<void> => {
    await api(`/api/lighting/${id}`, { method: 'DELETE' });
    if (sceneId === id) setSceneId('');
    void loadScenes();
    message.success('已删除');
  };

  const stepTitle = ['上传效果图', '编排灯具', '灯光时间轴', '出片'];

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="智能灯光场景演示"
        description="上传效果图，编排每盏灯并手工调整时间轴，生成灯光场景演示视频"
        extra={
          <Space>
            <Button onClick={() => setHistoryOpen(true)}>历史场景{scenes.length ? `（${scenes.length}）` : ''}</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setSceneId(''); setFixtures([]); setTracks([]); setVideoUrl(''); setAssetId(''); setImgSrc(''); setStep(0); }}>
              新建
            </Button>
          </Space>
        }
      />

      <Card>
        <Steps current={step} onChange={(v) => { if (v <= step || (v === 1 && imgSrc)) setStep(v); }} items={stepTitle.map((t) => ({ title: t }))} style={{ marginBottom: 20 }} />

        {step === 0 && (
          <div style={{ maxWidth: 720 }}>
            <Form layout="vertical">
              <Form.Item label="场景名称">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} placeholder="例如：万科红郡 · 观影模式演示" />
              </Form.Item>
              <Form.Item label="画幅比例">
                <Segmented options={[...RATIOS]} value={ratio} onChange={(v) => setRatio(String(v))} />
              </Form.Item>
            </Form>
            <Upload.Dragger
              accept="image/png,image/jpeg,image/webp"
              showUploadList={false}
              disabled={uploading}
              beforeUpload={async (file) => {
                setUploading(true);
                try {
                  const blob = await compressImage(file as File);
                  const fd = new FormData();
                  fd.append('file', blob);
                  const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
                  setAssetId(res.id);
                  setImgSrc(fileUrl(res.url));
                  message.success('效果图已上传');
                } catch (e) {
                  message.error(e instanceof Error ? e.message : '上传失败');
                } finally {
                  setUploading(false);
                }
                return false;
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击或拖拽上传客户效果图</p>
              <p className="ant-upload-hint">建议上传已含空间结构的效果图，灯具位置以此为参照。支持 JPG / PNG / WebP，10MB 内</p>
            </Upload.Dragger>
            {imgSrc && <Button type="primary" style={{ marginTop: 16 }} onClick={() => setStep(1)}>下一步：编排灯具</Button>}
          </div>
        )}

        {step === 1 && (
          <div>
            <Space wrap style={{ marginBottom: 12 }}>
              <Text>添加灯具：</Text>
              {TYPES.map((t) => (
                <Button
                  key={t.value}
                  size="small"
                  onClick={(e) => {
                    const rect = stageRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    const fx = makeFixture(t.value, 0.5, 0.5, fixtures.length + 1);
                    setFixtures((prev) => [...prev, fx]);
                    setSelected(fx.id);
                    e.preventDefault();
                  }}
                >
                  + {t.label}
                </Button>
              ))}
              <Text type="secondary">也可以直接在图上点选放置</Text>
            </Space>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div
                ref={stageRef}
                onPointerDown={onStagePointerDown}
                onPointerMove={onStagePointerMove}
                onPointerUp={() => { dragRef.current = null; }}
                onPointerLeave={() => { dragRef.current = null; }}
                style={{ position: 'relative', aspectRatio: aspect, maxHeight: 560, flex: '1 1 520px', minWidth: 300, background: '#F5F5F7', borderRadius: 12, overflow: 'hidden', cursor: 'crosshair' }}
              >
                {imgSrc ? <img src={imgSrc} alt="参考效果图" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }} /> : <Empty description="请先回到第一步上传效果图" />}
                {fixtures.map((f) => {
                  const size = TYPE_SIZE[f.type];
                  const active = f.id === selected;
                  return (
                    <div
                      key={f.id}
                      title={`${f.name}（${TYPE_LABEL[f.type]}）`}
                      onPointerDown={(e) => { e.stopPropagation(); setSelected(f.id); dragRef.current = { id: f.id }; }}
                      style={{
                        position: 'absolute',
                        left: `${f.x * 100}%`,
                        top: `${f.y * 100}%`,
                        transform: 'translate(-50%, -50%)',
                        width: size,
                        height: size,
                        borderRadius: '50%',
                        background: `radial-gradient(circle, ${kelvinToRgb(f.colorTemp)}cc 0%, ${kelvinToRgb(f.colorTemp)}44 42%, transparent 72%)`,
                        opacity: 0.25 + (f.brightness / 100) * 0.75,
                        border: `2px solid ${active ? '#5B5BF0' : 'rgba(0,0,0,.28)'}`,
                        boxShadow: active ? '0 0 0 3px rgba(91,91,240,.22)' : 'none',
                        pointerEvents: 'none',
                        cursor: 'move',
                      }}
                    />
                  );
                })}
              </div>

              <Card size="small" style={stacked ? { width: '100%' } : { flex: '0 0 300px', width: 300 }} title={`灯具列表（${fixtures.length}）`}>
                {fixtures.length === 0 && <Text type="secondary">还没有灯具，点上方按钮或直接点图添加</Text>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflowY: 'auto' }}>
                  {[...fixtures].sort((a, b) => a.order - b.order).map((f, i, arr) => (
                    <Card
                      key={f.id}
                      size="small"
                      onClick={() => setSelected(f.id)}
                      style={{ borderColor: f.id === selected ? '#5B5BF0' : undefined, background: f.id === selected ? '#F5F4FF' : undefined }}
                      styles={{ body: { padding: 10 } }}
                    >
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        <Space size={6} style={{ width: '100%' }}>
                          <Select
                            size="small"
                            value={f.type}
                            style={{ width: 96 }}
                            options={TYPES.map((t) => ({ value: t.value, label: t.label }))}
                            onChange={(v) => patchFixture(f.id, { type: v as FixtureType })}
                          />
                          <Input size="small" value={f.name} style={{ flex: 1 }} onChange={(e) => patchFixture(f.id, { name: e.target.value })} />
                        </Space>
                        <Space size={4}>
                          <Tooltip title="上移（影响出片顺序）"><Button size="small" disabled={i === 0} onClick={() => moveFixture(f.id, -1)}>↑</Button></Tooltip>
                          <Tooltip title="下移"><Button size="small" disabled={i === arr.length - 1} onClick={() => moveFixture(f.id, 1)}>↓</Button></Tooltip>
                          <Popconfirm title="删除这盏灯？" onConfirm={() => removeFixture(f.id)}>
                            <Button size="small" danger>删除</Button>
                          </Popconfirm>
                        </Space>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>常暗（不参与时间轴）</Text>
                          <Switch size="small" checked={f.alwaysDim} onChange={(v) => patchFixture(f.id, { alwaysDim: v })} />
                        </div>
                        {!f.alwaysDim && (
                          <>
                            <div>
                              <Text type="secondary" style={{ fontSize: 12 }}>亮度 {f.brightness}%</Text>
                              <Slider min={0} max={100} value={f.brightness} onChange={(v) => patchFixture(f.id, { brightness: v })} style={{ margin: 0 }} />
                            </div>
                            <div>
                              <Text type="secondary" style={{ fontSize: 12 }}>色温 {f.colorTemp}K</Text>
                              <Slider min={2200} max={6500} step={100} value={f.colorTemp} onChange={(v) => patchFixture(f.id, { colorTemp: v })} style={{ margin: 0 }} />
                            </div>
                          </>
                        )}
                      </Space>
                    </Card>
                  ))}
                </div>
              </Card>
            </div>

            <Space style={{ marginTop: 16 }}>
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button type="primary" disabled={fixtures.length === 0} onClick={() => setStep(2)}>下一步：灯光时间轴</Button>
            </Space>
          </div>
        )}

        {step === 2 && (
          <div>
            <Space wrap style={{ marginBottom: 12 }}>
              <Text>片长</Text>
              <InputNumber min={3} max={12} value={durationSec} onChange={(v) => setDurationSec(Number(v) || 6)} addonAfter="秒" style={{ width: 110 }} />
              <Button type={playing ? 'default' : 'primary'} onClick={() => { if (playhead >= 1) setPlayhead(0); setPlaying(!playing); }}>
                {playing ? '暂停' : '播放预览'}
              </Button>
              <Button onClick={() => setPlayhead(0)}>回到开头</Button>
              <Text type="secondary">在轨道上点击空白处添加关键帧，拖动圆点改时间，选中关键帧可调亮度与色温</Text>
            </Space>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={stacked ? { width: '100%' } : { flex: '1 1 480px', minWidth: 320 }}>
                <div style={{ position: 'relative', aspectRatio: aspect, maxHeight: 420, background: '#F5F5F7', borderRadius: 12, overflow: 'hidden' }}>
                  {imgSrc ? <img src={imgSrc} alt="预览底图" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} /> : null}
                  {fixtures.map((f) => {
                    const s = sampleAt(tracks.find((x) => x.fixtureId === f.id), playhead, f);
                    const size = TYPE_SIZE[f.type];
                    return (
                      <div
                        key={f.id}
                        style={{
                          position: 'absolute',
                          left: `${f.x * 100}%`,
                          top: `${f.y * 100}%`,
                          transform: 'translate(-50%, -50%)',
                          width: size,
                          height: size,
                          borderRadius: '50%',
                          background: `radial-gradient(circle, ${kelvinToRgb(s.colorTemp)}dd 0%, ${kelvinToRgb(s.colorTemp)}55 42%, transparent 72%)`,
                          opacity: 0.2 + (s.brightness / 100) * 0.8,
                          pointerEvents: 'none',
                          transition: playing ? 'none' : 'opacity .12s linear',
                        }}
                      />
                    );
                  })}
                  <div style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(0,0,0,.62)', color: '#fff', borderRadius: 6, padding: '2px 8px', fontSize: 12 }}>
                    {(playhead * durationSec).toFixed(1)}s / {durationSec}s
                  </div>
                </div>
              </div>

              <Card size="small" style={stacked ? { width: '100%' } : { flex: '0 0 280px', width: 280 }} title="关键帧">
                {(() => {
                  const activeFixture = fixtures.find((f) => f.id === selected);
                  if (!activeFixture) return <Text type="secondary">先在左侧灯具列表里选中一盏灯</Text>;
                  const track = tracks.find((t) => t.fixtureId === activeFixture.id);
                  const kfs = [...(track?.keyframes ?? [])].sort((a, b) => a.t - b.t);
                  return (
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Text strong>{activeFixture.name}</Text>
                      {activeFixture.alwaysDim && <Tag color="default">常暗，不参与时间轴</Tag>}
                      {kfs.length === 0 && <Text type="secondary">该灯还没有关键帧</Text>}
                      {kfs.map((k, i) => {
                        const near = Math.abs(k.t - playhead) < 0.06;
                        return (
                          <Card key={`${k.t}-${i}`} size="small" onClick={() => setPlayhead(k.t)} style={{ borderColor: near ? '#5B5BF0' : undefined }} styles={{ body: { padding: 8 } }}>
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              <Space size={6}>
                                <Text style={{ fontSize: 12 }}>{(k.t * durationSec).toFixed(1)}s</Text>
                                <Tag
                                  color="default"
                                  style={{ cursor: 'pointer', margin: 0 }}
                                  onClick={(e) => { e.stopPropagation(); removeKeyframe(activeFixture.id, i); }}
                                >
                                  删除
                                </Tag>
                              </Space>
                              <Slider
                                min={0}
                                max={100}
                                value={k.brightness}
                                onChange={(v) => updateKeyframe(activeFixture.id, i, { brightness: v })}
                                tooltip={{ formatter: (v) => `亮度 ${v}%` }}
                              />
                              <Slider
                                min={2200}
                                max={6500}
                                step={100}
                                value={k.colorTemp}
                                onChange={(v) => updateKeyframe(activeFixture.id, i, { colorTemp: v })}
                                tooltip={{ formatter: (v) => `色温 ${v}K` }}
                              />
                            </Space>
                          </Card>
                        );
                      })}
                    </Space>
                  );
                })()}
              </Card>
            </div>

            <Card size="small" title="灯光轨道时间轴" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', fontSize: 12, color: '#8C8C8C', marginBottom: 4 }}>
                {Array.from({ length: durationSec + 1 }, (_, i) => (
                  <span key={i} style={{ flex: 1, textAlign: i === 0 ? 'left' : 'center' }}>{i}s</span>
                ))}
              </div>
              <div style={{ position: 'relative' }}>
                {[...fixtures].sort((a, b) => a.order - b.order).map((f) => {
                  const track = tracks.find((t) => t.fixtureId === f.id);
                  const kfs = [...(track?.keyframes ?? [])].sort((a, b) => a.t - b.t);
                  return (
                    <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div
                        onClick={() => setSelected(f.id)}
                        style={{ flex: '0 0 96px', fontSize: 12, cursor: 'pointer', color: f.id === selected ? '#5B5BF0' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {f.name}{f.alwaysDim ? '（常暗）' : ''}
                      </div>
                      <div
                        onPointerDown={(e) => onTimelinePointerDown(e, f.id)}
                        onPointerMove={(e) => { if (kfDragRef.current) onTimelinePointerDown(e, f.id); }}
                        onPointerUp={() => { kfDragRef.current = null; }}
                        onPointerLeave={() => { kfDragRef.current = null; }}
                        style={{ position: 'relative', flex: 1, height: 30, background: '#F5F5F7', borderRadius: 6, border: f.id === selected ? '1px solid #5B5BF0' : '1px solid #E8E8ED', cursor: 'crosshair' }}
                      >
                        {kfs.length > 1 && (
                          <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                            <polyline
                              points={kfs.map((k) => `${k.t * 100},${28 - (k.brightness / 100) * 24}`).join(' ')}
                              fill="none"
                              stroke="#5B5BF0"
                              strokeWidth={2}
                            />
                          </svg>
                        )}
                        {kfs.map((k, i) => (
                          <div
                            key={`${k.t}-${i}`}
                            onPointerDown={(e) => { e.stopPropagation(); setSelected(f.id); kfDragRef.current = { fixtureId: f.id, index: i }; }}
                            title={`${(k.t * durationSec).toFixed(1)}s · ${k.brightness}% · ${k.colorTemp}K`}
                            style={{
                              position: 'absolute',
                              left: `calc(${k.t * 100}% - 6px)`,
                              bottom: 3 + (k.brightness / 100) * 18,
                              width: 12,
                              height: 12,
                              borderRadius: '50%',
                              background: '#5B5BF0',
                              border: '2px solid #fff',
                              cursor: 'ew-resize',
                              pointerEvents: 'auto',
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div style={{ position: 'absolute', left: 104, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', left: `${playhead * 100}%`, top: 0, bottom: 0, width: 2, background: '#EB2F96' }} />
                </div>
              </div>
            </Card>

            <Space style={{ marginTop: 16 }}>
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button type="primary" onClick={() => setStep(3)}>下一步：出片</Button>
            </Space>
          </div>
        )}

        {step === 3 && (
          <div style={{ maxWidth: 880 }}>
            <Card size="small" title="出片">
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Text type="secondary">
                  将把已编排的 {fixtures.length} 盏灯与 {tracks.reduce((s, t) => s + t.keyframes.length, 0)} 个关键帧翻译成画面描述，
                  以参考效果图为首帧生成 {durationSec} 秒灯光场景视频。预览与出片使用同一份数据。
                </Text>
                <Card size="small" styles={{ body: { padding: 12, background: '#FAFAFC', fontSize: 12, lineHeight: 1.8 } }}>
                  {buildVideoPrompt(fixtures, timeline)}
                </Card>
                <Space>
                  <Button onClick={() => setStep(2)}>返回时间轴</Button>
                  <Button type="primary" icon={<ThunderboltOutlined />} loading={rendering} onClick={() => void generate()}>
                    生成灯光场景视频
                  </Button>
                </Space>
                {videoUrl && (
                  <video src={videoUrl} controls style={{ width: '100%', borderRadius: 12, background: '#000' }} />
                )}
              </Space>
            </Card>
          </div>
        )}
      </Card>

      <Modal open={historyOpen} title="历史灯光场景" footer={null} onCancel={() => setHistoryOpen(false)}>
        {scenes.length === 0 ? (
          <Empty description="还没有保存过灯光场景" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {scenes.map((s) => (
              <Card key={s.id} size="small" hoverable onClick={() => void openScene(s.id)}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Space direction="vertical" size={0}>
                    <Text strong>{s.title}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{s.ratio} · {new Date(s.createdAt).toLocaleString('zh-CN')}</Text>
                  </Space>
                  <Space>
                    <Tag color={s.status === 'ready' ? 'green' : 'blue'}>{s.status === 'ready' ? '已出片' : '编排中'}</Tag>
                    <Popconfirm title="删除该场景？" onConfirm={(e) => { e?.stopPropagation(); void removeScene(s.id); }}>
                      <Button size="small" danger onClick={(e) => e.stopPropagation()}>删除</Button>
                    </Popconfirm>
                  </Space>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Modal>
    </div>
  );
}