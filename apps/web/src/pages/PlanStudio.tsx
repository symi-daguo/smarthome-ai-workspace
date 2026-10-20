import {
  CheckCircleOutlined,
  DeleteOutlined,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  LeftOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Alert, App as AntApp, Button, Checkbox, Drawer, Empty, Form, Grid, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Spin, Steps, Tag, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FLOORPLAN_TEMPLATES, MARKER_TEMPLATES, floorplanTemplate, markerTemplate, type FloorplanTemplate, type MarkerTemplate } from '../data/planTemplates';
import { api, fileUrl } from '../lib/api';
import { downloadBlob } from '../lib/download';
import { newRequestId } from '../lib/request-id';
import { compressImage } from '../lib/compress';
import { deliverPages, floorplanListPageNo } from '../lib/planPages';
import { FLOORPLAN_MAX, appendFloorplanFiles, type FloorplanSlot } from '../lib/floorplan';
import {
  RENDER_MAX, ROOM_OPTIONS, checkRenderUpload, checkRenderReady,
  toggleRepresentative, onRoomChanged, renderPageCount, ensureRepresentatives as ensureRepresentativeList,
  type RenderAsset,
} from '../lib/renderAsset';
import {
  CORE_MODULES, PAGE_COUNT_MAX,
  materialPageMinimum, resolvePageCount, pageCountHint,
} from '../lib/pageBudget';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';
import { PLAN_THEMES, PAGE_TYPE_LABEL, planTheme, type PlanPage, type PlanTheme } from '../data/planThemes';
import { exportPlanPptx, buildNarrationText, type PlanForExport } from '../lib/planPptx';
import { PlanSlide, PAGE_BULLET_LIMIT } from '../components/PlanSlide';

const { Text, Title } = Typography;

/** 「补充需求与服务资料」9 项，顺序与参考站 P2_SALES_FIELDS 一致 */
const SALES_FIELDS: { name: string; label: string; placeholder: string; extra?: string }[] = [
  { name: 'priorityNeeds', label: '最重要的需求（按优先级）', placeholder: '例如：先解决起夜照明，再考虑客厅会客；仅填写客户已表达的需求' },
  { name: 'excludedItems', label: '明确不做的项目', placeholder: '例如：不做窗帘联动、不增加摄像头' },
  { name: 'renovationStage', label: '装修阶段', placeholder: '例如：准备水电、已精装入住；不确定可留空' },
  { name: 'existingDevices', label: '现有设备与生态', placeholder: '填写已有设备、希望保留的开关与控制习惯' },
  { name: 'serviceEvidence', label: '真实案例或交付依据', placeholder: '填写同类项目、实际解决的问题及可核对的记录；没有就留空' },
  { name: 'serviceScope', label: '已确认服务范围', placeholder: '填写包含/不包含的服务、现场对接、使用指导和售后范围' },
  { name: 'serviceContact', label: '负责人与联系入口', placeholder: '填写可向业主展示的负责人、电话或微信', extra: '不会自动使用登录账号信息，避免把不该给客户的联系方式带出去' },
  { name: 'budgetItems', label: '已确认参考费用（选填）', placeholder: '每行一条：本次|灯光与开关|2500-3000', extra: '这些项目不计入本次合计，也不代替正式报价' },
  { name: 'budgetSource', label: '费用来源与日期', placeholder: '例如：门店确认的参考清单及日期；未确认价格可不填费用明细' },
];

const STEPS = ['客户资料', '逐页审稿', '生成与校对', '交付客户'];

/** 预检报出的字段名 → 人话（服务端只给字段 key，中文化放前端） */
const FIELD_LABEL: Record<string, string> = {
  heading: '主标题',
  subtitle: '副标题',
  bullets: '画面要点',
  body: '正文',
  narration: '本页讲解稿',
  quote: '底部引言',
};

/**
 * 预算档位预设：建面 × 单方造价（元/㎡）推导建议金额（万元）。
 * 档位只做"一键填入"与"按面积推荐"，用户始终可以自由改写预算原文。
 */
const BUDGET_TIERS = [
  { key: 'basic', name: '基础', unit: 600, desc: '主控 + 基础照明安防' },
  { key: 'comfort', name: '舒适', unit: 1000, desc: '全屋灯光 + 安防 + 网络' },
  { key: 'premium', name: '豪华', unit: 1600, desc: '影音 + 遮阳 + 暖通联动' },
  { key: 'custom', name: '定制', unit: 2600, desc: '全屋定制与深化设计' },
] as const;

/** 生态建议占比（合计 100%），用于预算分配建议条 */
const ECOSYSTEM_SPLIT = [
  { key: 'security', name: '安防', percent: 22, color: '#4A90D9' },
  { key: 'lighting', name: '灯光', percent: 24, color: '#E8A33D' },
  { key: 'shading', name: '遮阳', percent: 10, color: '#7C9E6B' },
  { key: 'media', name: '影音', percent: 18, color: '#9A6BC9' },
  { key: 'hvac', name: '暖通', percent: 14, color: '#4FB0A5' },
  { key: 'network', name: '网络', percent: 12, color: '#C96B6B' },
];

/** 未填面积时的参考建面，用于档位估算（页面会明说这是参考值） */
const REF_AREA = 120;

/** 合计与预算的差额容差（万元），避免浮点误差把"刚好对齐"误报成超出 */
const BUDGET_EPS = 0.05;

type BudgetReason = 'empty' | 'non-number' | 'non-positive' | 'ok';

/**
 * 解析预算（单位：万元）。只接受正数字，允许 "13" / "13万" / "13.5 万元" / "￥13"；
 * 其余情况给出 reason 供页面提示——不拦截提交，原文照常传给方案生成。
 */
function parseBudget(raw: string): { value: number | null; reason: BudgetReason } {
  const s = (raw ?? '').trim();
  if (!s) return { value: null, reason: 'empty' };
  const num = s.replace(/[,，¥￥\s]|万元|万|[wW]$/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(num)) return { value: null, reason: 'non-number' };
  const value = Number(num);
  // 0 与负数同样不参与分配建议计算（否则建议金额会变成负数），仅用 reason 做提示
  if (!Number.isFinite(value) || value <= 0) return { value: null, reason: 'non-positive' };
  return { value, reason: 'ok' };
}

/** 解析面积（㎡）：取首个数字，"130㎡" / "130 平米" / "130" 都能解析 */
function parseArea(raw: string): number | null {
  const m = (raw ?? '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 按建面推荐预算档位；未填面积时回落到"舒适" */
function recommendTier(area: number | null): (typeof BUDGET_TIERS)[number] {
  if (area === null) return BUDGET_TIERS[1];
  if (area < 90) return BUDGET_TIERS[0];
  if (area < 150) return BUDGET_TIERS[1];
  if (area < 220) return BUDGET_TIERS[2];
  return BUDGET_TIERS[3];
}

/** 档位建议金额（万元）：建面 × 单方造价，保留 1 位小数 */
function tierAmount(area: number, tier: (typeof BUDGET_TIERS)[number]): number {
  return Math.max(1, Math.round((area * tier.unit) / 1000) / 10);
}

const EDITIONS = [
  { key: 'standard', name: '标准完整方案（原版A）', desc: '适合需求明确后的完整汇报：需求、投入取舍、重点场景、预算范围、交付依据和下一步，共 9 个基础模块' },
  { key: 'presale', name: '售前定制提案（原版B）', desc: '售前沟通用，可按客户关注点裁剪' },
  { key: 'private', name: '私宅设计提案 · 新版', desc: '固定高端画册版型，细节更精' },
];

interface PlanDetail {
  id: string;
  title: string;
  customer: string;
  area: string;
  budget: string;
  ecosystem: string;
  store: string;
  highlights: string;
  keySpaces: string;
  needs: string;
  style: string;
  edition: string;
  /** 交付模版：户型图设计样式 + 产品放置样式 */
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
  pageCount: number;
  pages: PlanPage[];
  versionNo: number;
  shareToken: string;
  updatedAt: string;
  floorplanAssetId?: string | null;
  extraFloorplanAssetIds?: string[];
  floorplanFloors?: string[];
  /** 装修效果图：与 renderAssetIds 同序，room/representative/useMode 等分组信息存这里 */
  renderAssetIds?: string[];
  /** 绑定的场景视频（分享页内联播放） */
  videoAssetIds?: string[];
  videoTitles?: string[];
  renderAssetMeta?: {
    clientId?: string;
    room?: string;
    roomConfirmed?: boolean;
    useMode?: 'generate' | 'provided';
    sceneName?: string;
    representative?: boolean;
    fileName?: string;
  }[];
  /** AI 渲染的精装修效果图（基于客户户型图按方案风格+生态生成） */
  renderedFloorplanAssetId?: string | null;
  layoutPoints?: { name: string; category: string; x: number; y: number }[] | null;
  /** 服务端判定：当前这版文案已逐页校对过（reviewedRevision === versionNo） */
  reviewed?: boolean;
}

interface PlanListItem {
  id: string;
  title: string;
  customer: string;
  area: string;
  style: string;
  edition: string;
  /** 交付模版：户型图设计样式 + 产品放置样式 */
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
  pageCount: number;
  versionNo: number;
  shareToken: string;
  updatedAt: string;
}

/**
 * 导出用的完整方案数据 —— PPTX / 讲稿 / 交付包三处必须用同一份。
 *
 * 坑在这里：讲稿的页序取决于「有没有户型图」（有则多一页户型页，外加点位清单续页），
 * 而 `plan` 上只有 assetId、没有可直接加载的 URL。少传一次，门店拿到的讲稿就少两页，
 * 照着讲稿讲会讲错页。户型图 URL 在前端拼（带登录 token），不能落在服务端。
 */
const exportPayload = (p: PlanDetail): PlanForExport => ({
  ...p,
  floorplanUrl: p.floorplanAssetId ? fileUrl(`/api/media/assets/${p.floorplanAssetId}/file`) : null,
  renderedFloorplanUrl: p.renderedFloorplanAssetId ? fileUrl(`/api/media/assets/${p.renderedFloorplanAssetId}/file`) : null,
  layoutPoints: p.layoutPoints ?? null,
});

export function PlanStudio(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  // 窄屏只在首屏渲染前为 undefined，取 false 表示先按宽屏排版，避免列先出现再消失
  const isNarrow = screens.md === false;
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState('A');
  const [version, setVersion] = useState<'standard' | 'presale' | 'private'>('standard');
  // 交付模版（户型图设计 / 产品放置），与 PPTX、分享页同源
  const [fpTpl, setFpTpl] = useState<FloorplanTemplate>('annotated');
  const [mkTpl, setMkTpl] = useState<MarkerTemplate>('numbered');
  const [pageCount, setPageCount] = useState(9);
  /** 页数是否走「自定义」输入；档位按钮与自定义互斥，选档位会收起自定义 */
  const [customPages, setCustomPages] = useState(false);
  // 户型图素材（第 1 步上传，主图 = 第 1 张）。assetId 上传成功后才回填，
  // 提交时用它；文件名/大小/楼层先记本地，校验不过就不必白传一遍。
  const [fpSlots, setFpSlots] = useState<FloorplanSlot[]>([]);
  const [fpUploading, setFpUploading] = useState(false);
  /** 装修效果图：带空间分组与代表图。clientId 稳定标识，重渲染不丢 meta */
  const [raList, setRaList] = useState<RenderAsset[]>([]);
  const [raUploading, setRaUploading] = useState(false);
  /**
   * 两条选图路径：本地文件 / 从「我的资料」选。
   * 用 ref 拿隐藏 input，不用 document.querySelector —— 两个 input 都带 multiple，
   * 按选择器匹配等于靠 DOM 顺序赌，区块一调序就会静默弹出另一种文件选择器。
   */
  const fpInputRef = useRef<HTMLInputElement>(null);
  const raInputRef = useRef<HTMLInputElement>(null);
  const [raPickerOpen, setRaPickerOpen] = useState(false);
  /** 交付页绑定场景视频（最多 2 条）。不做现场生视频：模型是客户自备的 */
  const [vidPickerOpen, setVidPickerOpen] = useState(false);
  const [vidAssets, setVidAssets] = useState<{ id: string; title: string }[]>([]);
  const [vidPicked, setVidPicked] = useState<string[]>([]);
  const [boundVideos, setBoundVideos] = useState<string[]>([]);
  const [libAssets, setLibAssets] = useState<{ id: string; title: string }[]>([]);
  const [libPicked, setLibPicked] = useState<string[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [customValue, setCustomValue] = useState(9);
  const [form] = Form.useForm();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [generating, setGenerating] = useState(false);
  /** 提交幂等键：失败保留、成功清除，详见 lib/request-id.ts */
  const reqIdRef = useRef<string | null>(null);
  // 编辑中的那一页。bullets 用纯文本存（一行一条），保存时再拆成数组——
// 用户手上通常就是一段多行文案，让他对着 JSON 数组改是不合理的
const [editing, setEditing] = useState<{
    index: number;
    /** 打开弹窗那一刻的方案版本号，保存时做乐观锁比对 */
    versionNo: number;
    heading: string; subtitle: string; bullets: string; body: string; narration: string; quote: string;
  } | null>(null);
  const [savingPage, setSavingPage] = useState(false);
  const [savingTpl, setSavingTpl] = useState(false);
  /** 交付前的校对门：确认通过后自动执行原本要做的动作（导出 / 复制分享链接） */
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PlanListItem[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [showNarration, setShowNarration] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 打包三件套：要先跑一遍 canvas 预裁剪 + 点位合成，比单纯写 PPTX 慢，别共用一个 loading */
  const [packaging, setPackaging] = useState(false);
  /** 审稿页「完整文案」折叠区（参考站 A3：整篇视图与逐页视图并存） */
  const [deckTextOpen, setDeckTextOpen] = useState(false);
  /** 交付前预检结果（服务端判定，只读不扣额度）。null=还没查 */
  const [preflight, setPreflight] = useState<{
    canDeliver: boolean; pageCount: number;
    warnings: { index: number; heading: string; field: string; snippet: string }[];
  } | null>(null);
  const [renderingFloorplan, setRenderingFloorplan] = useState(false);
  /** 预算分配：只有用户改过的分类存覆盖值，其余跟随建议占比 */
  const [splitOverride, setSplitOverride] = useState<Record<string, number | null>>({});
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // 预算与面积实时联动（档位推荐、校验提示、分配建议条都读这里）
  const budgetRaw = Form.useWatch('budget', form) ?? '';
  const areaRaw = Form.useWatch('area', form) ?? '';
  const budgetParse = parseBudget(budgetRaw);
  const budgetTotal = budgetParse.value;
  const areaM2 = parseArea(areaRaw);
  const suggestedTier = recommendTier(areaM2);

  const loadHistory = async (): Promise<void> => {
    try {
      setHistory(await api<PlanListItem[]>('/api/plans'));
    } catch {
      setHistory([]);
    }
  };

  // 支持从侧栏历史直接带 ?id= 进入，打开对应方案继续编辑（同页切换方案也生效）
  const planId = searchParams.get('id');
  useEffect(() => {
    if (!planId) return;
    api<PlanDetail>(`/api/plans/${planId}`)
      .then((detail) => {
        setPlan(detail);
        setStyle(detail.style);
        setVersion(detail.edition as 'standard' | 'presale' | 'private');
        setFpTpl(floorplanTemplate(detail.floorplanTemplate));
        setMkTpl(markerTemplate(detail.markerTemplate));
        setPageCount(detail.pageCount);
        setActivePage(0);
        setStep(1);
      })
      .catch(() => {
        message.error('方案打开失败，可能已被删除');
      });
  }, [planId]);

  /** 选户型图：先本地校验（上限/去重/体积），通过再逐张上传拿 assetId */
  const pickFloorplans = async (files: FileList | null): Promise<void> => {
    if (!files || !files.length) return;
    const list = Array.from(files);
    const checked = appendFloorplanFiles(fpSlots, list);
    if (checked.error) { message.error(checked.error); return; }
    if (checked.skipped) message.info(`已忽略 ${checked.skipped} 张重复的户型图`);
    if (!checked.added) return;
    setFpUploading(true);
    try {
      const uploaded: FloorplanSlot[] = [];
      for (const slot of checked.slots) {
        if (slot.assetId) { uploaded.push(slot); continue; }
        const src = list.find((f) => f.name === slot.name && f.size === slot.size);
        if (!src) continue;
        const fd = new FormData();
        fd.append('file', src);
        fd.append('title', slot.name.replace(/\.[^.]+$/, '').slice(0, 60));
        const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
        uploaded.push({ ...slot, assetId: res.id });
      }
      setFpSlots(uploaded);
      message.success(`已添加 ${checked.added} 张户型图，共 ${uploaded.length} 张`);
    } catch (e) {
      message.error((e as Error).message || '户型图上传失败');
    } finally {
      setFpUploading(false);
    }
  };

  /** 选装修效果图：>8MB 或最长边>2048 才压缩（压缩逻辑复用 lib/compress） */
  const pickRenderAssets = async (files: FileList | null): Promise<void> => {
    if (!files || !files.length) return;
    const err = checkRenderUpload(raList.length + files.length);
    if (err) { message.error(err); return; }
    setRaUploading(true);
    try {
      const next = [...raList];
      for (const f of Array.from(files)) {
        if (next.length >= RENDER_MAX) break;
        const compressed = await compressImage(f);
        const fd = new FormData();
        fd.append('file', compressed);
        fd.append('title', f.name.replace(/\.[^.]+$/, '').slice(0, 60));
        const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
        next.push({
          assetId: res.id,
          clientId: (crypto.randomUUID?.() ?? `r_${Date.now()}_${next.length}`),
          name: f.name,
          room: '',
          representative: false,
          useMode: 'generate',
          sceneName: '',
          roomConfirmed: false,
        });
      }
      setRaList(next);
      message.success(`已添加 ${next.length - raList.length} 张效果图`);
    } catch (e) {
      message.error((e as Error).message || '效果图上传失败');
    } finally {
      setRaUploading(false);
    }
  };

  /** 打开「从我的资料选效果图」：复用已有素材库列表端点（与生图页选参考图同源） */
  const openRaPicker = async (): Promise<void> => {
    setRaPickerOpen(true);
    setLibLoading(true);
    try {
      const list = await api<{ id: string; kind: string; title: string }[]>('/api/media/assets');
      setLibAssets(list.filter((a) => a.kind === 'image').map((a) => ({ id: a.id, title: a.title })));
    } catch (e) {
      message.error((e as Error).message || '资料库加载失败');
    } finally {
      setLibLoading(false);
    }
  };

  /**
   * 从资料库追加效果图：资料库里已经是 MediaAsset，直接挂 id，不重复上传。
   * 已在本方案里的跳过 —— 同一张图挂两次会让代表图与页数折算算重。
   */
  const addFromLibrary = (): void => {
    const chosen = libAssets.filter((a) => libPicked.includes(a.id));
    if (!chosen.length) { setRaPickerOpen(false); return; }
    const have = new Set(raList.map((x) => x.assetId));
    const fresh = chosen.filter((a) => !have.has(a.id));
    const room = RENDER_MAX - raList.length;
    if (fresh.length > room) {
      message.warning(`本方案最多 ${RENDER_MAX} 张效果图，本次只加了前 ${room} 张`);
    }
    const take = fresh.slice(0, Math.max(0, room));
    setRaList((prev) => [
      ...prev,
      ...take.map((a) => ({
        assetId: a.id,
        clientId: (crypto.randomUUID?.() ?? `r_lib_${a.id}_${prev.length}`),
        name: a.title || '我的资料',
        room: '',
        representative: false,
        useMode: 'generate' as const,
        sceneName: '',
        roomConfirmed: false,
      })),
    ]);
    setLibPicked([]);
    setRaPickerOpen(false);
    message.success(`已添加 ${take.length} 张效果图，请填写实际空间并确认`);
  };

  /** 打开「绑定场景视频」弹层：只列已生成的视频，不在方案页现场生（要消耗额度且慢） */
  const openVidPicker = async (): Promise<void> => {
    setVidPickerOpen(true);
    try {
      const list = await api<{ id: string; kind: string; title: string; status: string }[]>('/api/media/assets');
      setVidAssets(list.filter((a) => a.kind === 'video' && a.status === 'ready').map((a) => ({ id: a.id, title: a.title })));
    } catch (e) {
      message.error((e as Error).message || '资料库加载失败');
    }
  };

  const bindVideos = async (): Promise<void> => {
    if (!plan) return;
    const ids = vidPicked.slice(0, 2);
    if (!ids.length) { setVidPickerOpen(false); return; }
    try {
      const r = await api<{ videoAssetIds: string[] }>(`/api/plans/${plan.id}/videos`, {
        method: 'PATCH',
        body: JSON.stringify({ videoAssetIds: ids }),
      });
      setBoundVideos(r.videoAssetIds);
      setVidPicked([]);
      setVidPickerOpen(false);
      message.success(`已绑定 ${r.videoAssetIds.length} 条场景视频，分享页与客户链接会内联播放`);
    } catch (e) {
      message.error((e as Error).message || '绑定失败');
    }
  };

  const confirmRoom = (i: number): void => {
    if (!raList[i]?.room.trim()) {
      message.warning('请先填写这张效果图对应的空间');
      return;
    }
    setRaList((prev) => ensureRepresentativeList(prev.map((a, x) => (x === i ? { ...a, roomConfirmed: true } : a))));
  };

  const generate = async (): Promise<void> => {
    let values: Record<string, string>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    // 提交前必须空间已填 + 已确认（前端先拦一道，服务端还会再拦一次）
    const raErr = checkRenderReady(raList);
    if (raErr) { message.error(raErr); return; }
    setGenerating(true);
    const rid = reqIdRef.current ?? newRequestId();
    reqIdRef.current = rid;
    try {
      const created = await api<PlanDetail & { deduped?: boolean }>('/api/plans', {
        method: 'POST',
        body: JSON.stringify({
          title: values.title,
          customer: values.customer ?? '',
          area: values.area ?? '',
          budget: values.budget ?? '',
          ecosystem: values.ecosystem ?? '',
          store: values.store ?? '',
          highlights: values.highlights ?? '',
          keySpaces: values.keySpaces ?? '',
          needs: values.needs ?? '',
          // 户型图：主图 + 额外图 + 楼层（对齐参考站第 1 步素材区）
          floorplanAssetId: fpSlots[0]?.assetId || null,
          extraFloorplanAssetIds: fpSlots.slice(1).map((x) => x.assetId).filter(Boolean),
          floorplanFloors: fpSlots.map((x) => x.floor),
          renderAssetIds: raList.map((x) => x.assetId).filter(Boolean),
          renderAssetMeta: raList.map((x) => ({
            clientId: x.clientId,
            room: x.room,
            roomConfirmed: x.roomConfirmed,
            useMode: x.useMode,
            sceneName: x.sceneName,
            representative: x.representative,
            fileName: x.name,
          })),
          // 补充资料 9 项：空串也照样传，后端 DTO 有默认值，不传会当成缺字段
          ...Object.fromEntries(SALES_FIELDS.map((f) => [f.name, (values as Record<string, string>)[f.name] ?? ''])),
          style,
          edition: version,
          floorplanTemplate: fpTpl,
          markerTemplate: mkTpl,
          // 提交时必须夹取到素材下限，不能直接传用户选的档位：
          // 选了 9 页但素材撑到 11 页时，按 9 提交就会真的少给客户 2 页，
          // 而且扣费也跟着按 9 算 —— 提示里写了「自动扩至 11 页」却不扩，是最坏的组合。
          pageCount: resolvePageCount(pageCount, materials, editionKey),
          clientRequestId: rid,
        }),
      });
      reqIdRef.current = null;
      setPlan(created);
      setStep(1);
      message.success(
        created.deduped
          ? '这次提交此前已生成过方案，直接取回原方案（未重复消耗算力）'
          : `方案文案已生成（${created.pages.length} 页），可逐页审稿编辑`,
      );
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  /** 打开某页的编辑弹窗。三个入口（卡片点击 / 回车 / 修改当前页）共用一份字段映射 */
  const startEdit = (index: number, p: PlanPage): void => {
    // 户型与点位页由已上传的户型图推导出来，没有可改的文案
    if (p.type === 'floorplan') {
      message.info('「户型与设备点位」由已上传的户型图自动生成，改图即可，不用改文案');
      return;
    }
    setEditing({
      index,
      // 记下打开这一刻的版本号，保存时做乐观锁比对
      versionNo: plan?.versionNo ?? 1,
      heading: p.heading,
      subtitle: p.subtitle ?? '',
      // bullets 是数组，编辑时按行拆成纯文本——用户手上是一段多行文案，不是 JSON
      bullets: (p.bullets ?? []).join('\n'),
      body: p.body,
      narration: p.narration,
      quote: p.quote ?? '',
    });
  };

  /**
   * 保存交付模版（户型图设计 / 产品放置）。
   *
   * 模版能改、且改完要让校对状态失效：服务端 bump versionNo 并清空 reviewedRevision，
   * 门店需要重新确认一次才能打包。这是有意的 —— 模版一变，客户看到的交付件就变了，
   * 旧的「已校对」结论不再成立。
   */
  const saveTemplates = async (): Promise<void> => {
    if (!plan) return;
    setSavingTpl(true);
    try {
      const updated = await api<PlanDetail>(`/api/plans/${plan.id}/templates`, {
        method: 'PATCH',
        body: JSON.stringify({ versionNo: plan.versionNo, floorplanTemplate: fpTpl, markerTemplate: mkTpl }),
      });
      setPlan(updated);
      setFpTpl(floorplanTemplate(updated.floorplanTemplate));
      setMkTpl(markerTemplate(updated.markerTemplate));
      if (step === 3) void runPreflight(updated.id);
      message.success(`交付模版已更新（版本 ${updated.versionNo}），请重新校对后再打包交付`);
    } catch (e) {
      message.error((e as Error).message || '模版保存失败');
    } finally {
      setSavingTpl(false);
    }
  };

  const savePage = async (): Promise<void> => {
    if (!editing || !plan) return;
    setSavingPage(true);
    try {
      const updated = await api<PlanDetail>(`/api/plans/${plan.id}/pages/${editing.index}`, {
        method: 'PATCH',
        body: JSON.stringify({
          // 乐观锁：带上打开弹窗那一刻的版本号。期间若有人保存过，服务端会 409
          // 而不是把对方的修改连同我的改动一起整份覆盖掉。
          versionNo: editing.versionNo,
          heading: editing.heading,
          subtitle: editing.subtitle,
          // 一行一条；空行在提示里就能看出来，服务端也会再过滤一次
          bullets: editing.bullets.split(/\r?\n/),
          body: editing.body,
          narration: editing.narration,
          quote: editing.quote,
        }),
      });
      setPlan(updated);
      setEditing(null);
      // 改过内容，之前那份预检结论可能已过时，立刻重查
      if (step === 3) void runPreflight(updated.id);
      message.success(`已保存，文案版本 ${updated.versionNo}`);
    } catch (e) {
      const err = e as Error & { code?: string; status?: number; currentVersionNo?: number };
      if (err.code === 'PLAN_VERSION_CONFLICT' || err.status === 409) {
        // 不提供「强制覆盖」：那份 pages 是整份 JSON，强写就是替对方做决定。
        // 只能重新载入最新版本，用户把自己的文字照着再改一遍。
        modal.confirm({
          title: '方案已被他人更新',
          content: `${err.message}。你本次的修改没有保存。是否重新载入最新版本？`,
          okText: '重新载入最新版本',
          cancelText: '先不载入',
          onOk: async () => {
            setEditing(null);
            const fresh = await api<PlanDetail>(`/api/plans/${plan.id}`);
            setPlan(fresh);
            message.info(`已载入 V${fresh.versionNo}`);
          },
        });
        return;
      }
      message.error(err.message || '保存失败');
    } finally {
      setSavingPage(false);
    }
  };

  const openPlan = async (id: string): Promise<void> => {
    try {
      const detail = await api<PlanDetail>(`/api/plans/${id}`);
      setPlan(detail);
      setStyle(detail.style);
      setVersion(detail.edition as 'standard' | 'presale' | 'private');
      setFpTpl(floorplanTemplate(detail.floorplanTemplate));
      setMkTpl(markerTemplate(detail.markerTemplate));
      setPageCount(detail.pageCount);
      // 效果图按存下来的 meta 回填：不回填的话，打开历史方案看到的是空白素材区，
      // 用户以为图没了，实际库里还在，重新生成还会把它们当新图再扣一遍额度。
      const ids = detail.renderAssetIds ?? [];
      const meta = detail.renderAssetMeta ?? [];
      setRaList(ids.map((assetId, i) => {
        const m = meta[i] ?? {};
        return {
          assetId,
          clientId: m.clientId ?? `r_saved_${assetId}`,
          name: m.fileName ?? '效果图',
          room: m.room ?? '',
          representative: m.representative ?? false,
          useMode: m.useMode ?? 'generate',
          sceneName: m.sceneName ?? '',
          roomConfirmed: m.roomConfirmed ?? false,
        };
      }));
      setBoundVideos(detail.videoAssetIds ?? []);
      setStep(1);
      setHistoryOpen(false);
      setPreflight(null);
    } catch (e) {
      message.error((e as Error).message || '打开失败');
    }
  };

  /** 交付前预检：只读、不扣额度。进入交付步时自动查一次 */
  const runPreflight = useCallback(async (planId: string): Promise<void> => {
    try {
      setPreflight(await api<typeof preflight>(`/api/plans/${planId}/preflight`));
    } catch (e) {
      message.error((e as Error).message || '预检失败');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shareUrl = plan ? `${window.location.origin}/share/plan/${plan.shareToken}` : '';

  /**
   * 交付前的一道门：没校对过就别把方案发出去。
   *
   * 参考站把这条门放在「生成下载文件」与「分享链接」两个动作上
   * （逆向原文见 audit §7.21）。这里同样只拦**交付动作**，
   * 不拦已发出链接的访问——那种做法等于让老客户手里的链接突然失效。
   */
  const requireReview = (action: () => void): void => {
    if (plan?.reviewed) {
      action();
      return;
    }
    setPendingAction(() => action);
    setReviewChecked(false);
    setReviewOpen(true);
  };

  const confirmReview = async (): Promise<void> => {
    if (!plan || !reviewChecked) return;
    try {
      const updated = await api<PlanDetail>(`/api/plans/${plan.id}/review`, { method: 'POST' });
      setPlan(updated);
      setReviewOpen(false);
      message.success('已标记本版为逐页校对完成');
      const act = pendingAction;
      setPendingAction(null);
      if (act) act();
    } catch (e) {
      message.error((e as Error).message || '确认失败');
    }
  };

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      message.success('分享链接已复制，发给客户微信打开即可');
    } catch {
      modal.info({ title: '分享链接', content: shareUrl });
    }
  };

  const doExportPptx = async (): Promise<void> => {
    if (!plan) return;
    setExporting(true);
    try {
      const { blob, fileName } = await exportPlanPptx(exportPayload(plan));
      downloadBlob(blob, fileName);
      message.success('PPTX 已下载（16:9 原生幻灯片，可直接编辑）');
    } catch (e) {
      message.error((e as Error).message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const downloadPptx = (): void => requireReview(() => void doExportPptx());

  /**
   * 交付三件套：PPTX + 完整讲稿 + 图片包，打成一个 zip 给客户。
   *
   * 为什么不直接下载：浏览器 blob 下载的文件名由宿主决定，实测一律落成随机名，
   * 而交付物的名字恰恰最不该丢。走服务端打包后，文件名由 Content-Disposition 给定，
   * 图片包也由服务端从 media 直接取，不必把原图再传一遍。
   */
  const doPackage = async (): Promise<void> => {
    if (!plan) return;
    setPackaging(true);
    try {
      const payload = exportPayload(plan);
      const { blob } = await exportPlanPptx(payload);
      const fd = new FormData();
      fd.append('pptx', new File([blob], `${plan.title}.pptx`, { type: 'application/octet-stream' }));
      fd.append('narration', buildNarrationText(payload));
      const res = await api<{ token: string; fileName: string; size: number; contents: string[] }>(
        `/api/plans/${plan.id}/package`,
        { method: 'POST', body: fd },
      );
      // 刻意**不**走 fileUrl：它会追加登录 token，URL 变成 ?token=签名&token=登录，
      // Express 那边 token 解析成数组，签名校验必然失败（实测 404 PACKAGE_LINK_INVALID）。
      // 下载端点本来就是 presigned 语义，不带任何登录态。
      const a = document.createElement('a');
      a.href = `/api/plans/package/download?token=${encodeURIComponent(res.token)}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      message.success(`交付包已生成（${res.contents.length} 个文件 · ${(res.size / 1024 / 1024).toFixed(1)} MB）：${res.fileName}`);
    } catch (e) {
      message.error((e as Error).message || '打包失败');
    } finally {
      setPackaging(false);
    }
  };

  const packageDelivery = (): void => requireReview(() => void doPackage());

  // 渲染精装修效果图：基于已挂接的客户户型图，按方案风格+生态 AI 出图
  const renderFloorplan = async (): Promise<void> => {
    if (!plan) return;
    if (!plan.floorplanAssetId) {
      message.warning('请先上传客户户型平面图');
      return;
    }
    setRenderingFloorplan(true);
    try {
      const r = await api<{ assetId: string; floorplanAssetId: string | null }>(`/api/plans/${plan.id}/render-floorplan`, { method: 'POST' });
      setPlan({ ...plan, renderedFloorplanAssetId: r.assetId });
      message.success(`精装修效果图已生成（${r.assetId.slice(0, 8)}…），空间动线页与分享页已自动用上`);
    } catch (e) {
      message.error((e as Error).message || '精装修生成失败');
    } finally {
      setRenderingFloorplan(false);
    }
  };

  const doDownloadScript = (): void => {
    if (!plan) return;
    // 走共用的 downloadBlob：本地那版在 a.click() 之后立刻 revokeObjectURL，
    // 下载还没开始就被撤掉，讲稿点了没反应。共用的那版延迟 5 秒释放。
    downloadBlob(new Blob([buildNarrationText(exportPayload(plan))], { type: 'text/markdown;charset=utf-8' }), `${plan.title}-完整讲稿.md`);
  };

  // 讲稿同样是发出去的文件，和 PPTX 走同一道门
  const downloadScript = (): void => requireReview(doDownloadScript);

  const reset = (): void => {
    setPlan(null);
    setStep(0);
    setActivePage(0);
    setSplitOverride({});
    // 素材区也要清：历史方案的图带回新方案，等于把上一单的东西复制给下一单
    setRaList([]);
    setFpSlots([]);
    form.resetFields();
  };

  const t = planTheme(plan?.style ?? style);
  // 幻灯片 plan 视图：带户型图与点位（空间动线页配图）
  const slidePlan = {
    store: plan?.store ?? '',
    floorplanUrl: plan?.floorplanAssetId ? fileUrl(`/api/media/assets/${plan.floorplanAssetId}/file`) : null,
    renderedFloorplanUrl: plan?.renderedFloorplanAssetId ? fileUrl(`/api/media/assets/${plan.renderedFloorplanAssetId}/file`) : null,
    layoutPoints: plan?.layoutPoints ?? null,
  };
  // 页数档位：默认基数 / 12 页（参考站同档位），自定义另开输入
  const pageChoices = useMemo(() => [CORE_MODULES, CORE_MODULES + 3], []);
  /**
   * 素材计数：户型图张数 + 效果图折算页数（按空间分组，不是图片张数）。
   * renderCount 写死 0 会让下限页数算少 —— 交付时素材页没地方摆，等于少给客户几页。
   */
  const materials = useMemo(() => ({
    floorplanCount: (plan?.floorplanAssetId ? 1 + (plan?.extraFloorplanAssetIds?.length ?? 0) : 0) || fpSlots.length,
    renderCount: renderPageCount(raList),
  }), [plan?.floorplanAssetId, plan?.extraFloorplanAssetIds, fpSlots.length, raList]);
  const editionKey: 'standard' | 'presale' | 'private' =
    version === 'presale' ? 'presale' : version === 'private' ? 'private' : 'standard';
  const budget = useMemo(
    () => pageCountHint(
      resolvePageCount(pageCount, materials, editionKey),
      pageCount, materials, editionKey,
    ),
    [pageCount, materials, editionKey],
  );
  const materialMin = useMemo(
    () => materialPageMinimum(materials, editionKey),
    [materials, editionKey],
  );

  // 交付页序：走 planPages.deliverPages（PPTX / 讲稿 / 分享页 / 本页预览共用同一份）。
  // 以前这里只插户型页、不插点位清单续页，于是门店在「生成与校对」里看到 10 页，
  // 导出的 PPT 是 11 页 —— 页数对不上，门店会以为少了一页。
  // virtualAt 是虚拟页（户型页 + 清单续页）的下标：它们没有文案，编辑时映射回真实页。
  const view = useMemo(
    () => deliverPages({
      pages: plan?.pages ?? [],
      floorplanUrl: slidePlan.floorplanUrl,
      renderedFloorplanUrl: slidePlan.renderedFloorplanUrl,
      layoutPoints: plan?.layoutPoints ?? null,
      floorplanTemplate: plan?.floorplanTemplate ?? null,
      markerTemplate: plan?.markerTemplate ?? null,
    }),
    [plan?.pages, plan?.layoutPoints, plan?.floorplanTemplate, plan?.markerTemplate,
      slidePlan.floorplanUrl, slidePlan.renderedFloorplanUrl],
  );
  const realIndexOf = (viewIndex: number): number =>
    viewIndex - view.virtualAt.filter((v) => v <= viewIndex).length;
  const active = view.pages[activePage];
  // 分配建议：预算有效时按占比给出建议金额，用户改过的分类用覆盖值（清空即恢复跟随建议）
  const splitRows = ECOSYSTEM_SPLIT.map((row) => {
    const override = splitOverride[row.key];
    const suggested = budgetTotal === null ? 0 : Math.round(budgetTotal * row.percent * 10) / 10;
    return { ...row, value: override === null || override === undefined ? suggested : override };
  });
  const splitSum = Math.round(splitRows.reduce((sum, row) => sum + row.value, 0) * 10) / 10;
  const budgetGap = budgetTotal === null ? 0 : Math.round((splitSum - budgetTotal) * 10) / 10;
  const overBudget = budgetTotal !== null && budgetGap > BUDGET_EPS;

  return (
    <div style={pageContainerStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Title level={3} style={{ marginBottom: 4 }}>新建智能方案</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {EDITIONS.find((e) => e.key === version)?.name.split('（')[0]} · {plan ? `文案版本 ${plan.versionNo}` : '待继续 · 文案版本 0'}
          </Text>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} onClick={reset}>新建方案</Button>
          <Button icon={<HistoryOutlined />} onClick={() => { void loadHistory(); setHistoryOpen(true); }}>历史方案</Button>
        </Space>
      </div>

      <Steps
        current={step}
        items={STEPS.map((s) => ({ title: s }))}
        style={{ margin: '0 auto 28px' }}
      />

      {/* 步骤 1：客户资料 */}
      {step === 0 ? (
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <Form form={form} layout="vertical" style={{ flex: 1, minWidth: 320, maxWidth: 560 }}>
            <Form.Item label="小区 / 项目名称" name="title" rules={[{ required: true, message: '请输入项目名称' }]}>
              <Input placeholder="例如：汉江一品" size="large" />
            </Form.Item>
            <Form.Item label="方案客户称呼" name="customer" extra="如：张先生；留空则不显示姓名">
              <Input placeholder="选填" size="large" />
            </Form.Item>
            <Form.Item label="面积" name="area">
              <Input placeholder="例如：130㎡" size="large" />
            </Form.Item>
            <Form.Item
              label="预算（万元）"
              name="budget"
              validateStatus={budgetParse.reason === 'non-number' || budgetParse.reason === 'non-positive' ? 'warning' : undefined}
              help={
                budgetParse.reason === 'empty'
                  ? '留空表示不限预算，方案生成时按常见区间给建议'
                  : budgetParse.reason === 'non-number'
                    ? '预算需为数字（单位：万元）；当前内容仍会原样传入，不会阻断生成'
                    : budgetParse.reason === 'non-positive'
                      ? '预算需大于 0；当前值仍会原样传入，请确认是否为预期'
                      : undefined
              }
            >
              <Input placeholder="例如：13；留空表示不限" size="large" inputMode="decimal" allowClear />
            </Form.Item>

            {/* 预算档位预设：按面积推荐，点一下即写入预算（不限制自由输入） */}
            <div style={{ marginBottom: 20 }}>
              <Text strong style={{ fontSize: 12.5, display: 'block', marginBottom: 8 }}>
                预算档位预设
                <Tag color="blue" style={{ marginLeft: 8, marginRight: 0 }}>
                  按 {areaM2 ?? REF_AREA}㎡ 推荐：{suggestedTier.name}
                </Tag>
              </Text>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {BUDGET_TIERS.map((tier) => {
                  const amount = tierAmount(areaM2 ?? REF_AREA, tier);
                  const picked = budgetTotal !== null && Math.abs(budgetTotal - amount) < BUDGET_EPS;
                  return (
                    <div
                      key={tier.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => form.setFieldValue('budget', String(amount))}
                      onKeyDown={(e) => e.key === 'Enter' && form.setFieldValue('budget', String(amount))}
                      style={{
                        flex: isNarrow ? '1 1 calc(50% - 4px)' : '1 1 0',
                        minWidth: 140,
                        padding: '8px 10px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        border: `1px solid ${picked ? token.colorPrimary : token.colorBorderSecondary}`,
                        background: picked ? token.colorPrimaryBg : token.colorBgContainer,
                      }}
                    >
                      <Text strong style={{ fontSize: 13, display: 'block' }}>{tier.name} · 约 {amount} 万</Text>
                      <Text type="secondary" style={{ fontSize: 11.5 }}>{tier.desc}</Text>
                    </div>
                  );
                })}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                {areaM2 === null
                  ? `未填面积，按参考建面 ${REF_AREA}㎡ 估算，填入面积后会自动换算`
                  : `按 ${areaM2}㎡ × 单方造价估算，点击即写入预算框`}
              </Text>
            </div>

            {/* 预算分配建议条：按生态给出占比，金额可改；合计超预算只提示不阻断 */}
            <div
              style={{
                marginBottom: 24,
                padding: 12,
                borderRadius: 12,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorFillQuaternary,
              }}
            >
              <Text strong style={{ fontSize: 12.5 }}>预算分配建议</Text>
              <Text type="secondary" style={{ fontSize: 11.5, display: 'block', marginTop: 2 }}>
                按生态给出建议占比与金额，金额可改；合计超出预算只提示，不阻断生成
              </Text>
              {budgetTotal !== null ? (
                <div style={{ marginTop: 10 }}>
                  <Progress
                    percent={Math.min(100, Math.round((splitSum / budgetTotal) * 100))}
                    status={overBudget ? 'exception' : 'normal'}
                    size="small"
                  />
                  <Text style={{ fontSize: 12, display: 'block' }}>
                    合计 {splitSum} 万 / 预算 {budgetTotal} 万
                    {overBudget ? (
                      <Text type="danger" style={{ fontSize: 12 }}> · 超出 {budgetGap} 万，可下调分项或提高预算</Text>
                    ) : budgetGap < -BUDGET_EPS ? (
                      <Text type="secondary" style={{ fontSize: 12 }}> · 尚余 {-budgetGap} 万未分配</Text>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}> · 与预算基本一致</Text>
                    )}
                  </Text>
                </div>
              ) : (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  填写有效预算后显示建议金额；当前仅显示生态占比参考
                </Text>
              )}
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {splitRows.map((row) => (
                  <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: isNarrow ? 'wrap' : 'nowrap' }}>
                    <Text style={{ fontSize: 12, width: isNarrow ? 40 : 44, flex: 'none' }}>{row.name}</Text>
                    <Progress
                      percent={
                        budgetTotal !== null && budgetTotal > 0
                          ? Math.min(100, Math.round((row.value / budgetTotal) * 100))
                          : row.percent
                      }
                      showInfo={false}
                      strokeColor={row.color}
                      size="small"
                      style={{ flex: 1, minWidth: isNarrow ? 60 : 120, margin: 0 }}
                    />
                    <Text type="secondary" style={{ fontSize: 11.5, width: 38, textAlign: 'right', flex: 'none' }}>{row.percent}%</Text>
                    <InputNumber
                      size="small"
                      min={0}
                      max={99999}
                      step={0.5}
                      value={budgetTotal === null ? null : row.value}
                      disabled={budgetTotal === null}
                      onChange={(v) => setSplitOverride((prev) => ({ ...prev, [row.key]: v }))}
                      style={{ width: isNarrow ? 72 : 86, flex: 'none' }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <Form.Item label="智能生态" name="ecosystem">
              <Input placeholder="例如：米家 / 可扩展全屋智能" size="large" />
            </Form.Item>
            <Form.Item label="门店品牌名" name="store">
              <Input placeholder="例如：XX 智能家居体验馆" size="large" />
            </Form.Item>
            <Form.Item label="重点空间" name="keySpaces">
              <Input placeholder="例如：客餐厅灯光、主卧睡眠、全屋 WiFi" size="large" />
            </Form.Item>
            <Form.Item label="服务亮点" name="highlights" extra="填写实际提供的服务，不填写未经确认的时效或质保承诺">
              <Input.TextArea rows={2} placeholder="例如：全屋智能设计、选品、安装调试一站式" />
            </Form.Item>
            <Form.Item label="客户需求" name="needs">
              <Input.TextArea rows={3} placeholder="请写清家庭成员、装修阶段、预算、重点空间和最想实现的生活场景。" />
            </Form.Item>

            {/* 户型图素材（对齐参考站第 1 步 p2Floorplan 区）：
                最多 3 张、可分次追加、重复自动忽略、单文件 20MB / 总量 35MB、每张标楼层。
                第 1 张为主图，第 3 步的布点与精装修生成都用主图。 */}
            <div style={{ marginTop: 18 }}>
              <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 6 }}>户型图（最多 {FLOORPLAN_MAX} 张）</Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8, lineHeight: 1.7 }}>
                可一次选多张，也可分次追加；同一张重复选择会自动忽略。多层住宅请按张标明楼层，第 1 张用于后续布点与精装修生成。
              </Text>
              <input
                ref={fpInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => { void pickFloorplans(e.target.files); e.target.value = ''; }}
              />
              <Button loading={fpUploading} onClick={() => fpInputRef.current?.click()}>
                选择户型图
              </Button>
              {fpSlots.length ? (
                <div style={{ marginTop: 10 }}>
                  {fpSlots.map((slot, i) => (
                    <div key={`${slot.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <Text type="secondary" style={{ fontSize: 12, flex: 'none', width: 130 }} ellipsis>{slot.name}</Text>
                      <Input
                        size="small"
                        style={{ width: 120 }}
                        value={slot.floor}
                        onChange={(e) => setFpSlots((prev) => prev.map((x, xi) => xi === i ? { ...x, floor: e.target.value.slice(0, 20) } : x))}
                        placeholder="楼层，如 一层"
                      />
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => setFpSlots((prev) => prev.filter((_, xi) => xi !== i))}
                      />
                    </div>
                  ))}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    已选 {fpSlots.length} 张 · 合计 {(fpSlots.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(1)} MB
                  </Text>
                </div>
              ) : null}
            </div>

            {/* 装修效果图（对齐参考站 p2RenderImages 区）：
                上限 5 张；每张要填实际空间并确认；同一空间只能有一张代表图
                （主视觉唯一来源）；用途区分「生成场景对比」与「直接展示已有状态图」。 */}
            <div style={{ marginTop: 18 }}>
              <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 6 }}>装修效果图（最多 {RENDER_MAX} 张）</Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8, lineHeight: 1.7 }}>
                可一次选多张，也可分次追加。同名空间归为同一实际空间，不同楼层请写进名字里。
                同一空间只能勾选一张代表图，它会作为该空间的方案主视觉。
              </Text>
              <input
                ref={raInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => { void pickRenderAssets(e.target.files); e.target.value = ''; }}
              />
              <Space wrap>
                <Button loading={raUploading} onClick={() => raInputRef.current?.click()}>
                  选择效果图
                </Button>
                <Button data-testid="ra-picker-btn" onClick={() => void openRaPicker()}>
                  从我的资料选
                </Button>
              </Space>
              {raList.length ? (
                <div style={{ marginTop: 10 }}>
                  <datalist id="renderRoomOptions">
                    {ROOM_OPTIONS.map((r) => <option key={r} value={r} />)}
                  </datalist>
                  {raList.map((a, i) => (
                    <div key={a.clientId} style={{ border: '1px solid', borderColor: token.colorBorderSecondary, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>{a.name}</Text>
                        <Tag color={a.roomConfirmed ? 'success' : 'warning'} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          {a.roomConfirmed ? '已确认' : '待确认'}
                        </Tag>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setRaList((prev) => prev.filter((_, x) => x !== i))} />
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <Input
                          size="small"
                          list="renderRoomOptions"
                          placeholder="实际空间，如 一层客厅"
                          style={{ width: 170 }}
                          value={a.room}
                          onChange={(e) => setRaList((prev) => onRoomChanged(prev, i, e.target.value))}
                        />
                        <Tooltip title={a.room.trim() ? '作为该空间的方案主视觉' : '先填空间才能选代表图'}>
                          <Checkbox
                            checked={a.representative}
                            disabled={!a.room.trim()}
                            onChange={() => setRaList((prev) => toggleRepresentative(prev, i))}
                          >
                            空间代表图
                          </Checkbox>
                        </Tooltip>
                        <Select
                          size="small"
                          style={{ width: 165 }}
                          value={a.useMode}
                          onChange={(v) => setRaList((prev) => prev.map((x, xi) => xi === i ? { ...x, useMode: v, roomConfirmed: false } : x))}
                          options={[
                            { value: 'generate', label: '生成场景对比' },
                            { value: 'provided', label: '直接展示已有状态图' },
                          ]}
                        />
                        {a.useMode === 'provided' ? (
                          <Input
                            size="small"
                            placeholder="场景名称，如 观影模式"
                            style={{ width: 150 }}
                            value={a.sceneName}
                            onChange={(e) => setRaList((prev) => prev.map((x, xi) => xi === i ? { ...x, sceneName: e.target.value } : x))}
                          />
                        ) : null}
                        <Button size="small" onClick={() => confirmRoom(i)} disabled={a.roomConfirmed}>确认空间</Button>
                      </div>
                    </div>
                  ))}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    已选 {raList.length}/{RENDER_MAX} 张 · 已确认 {raList.filter((x) => x.roomConfirmed).length}/{raList.length} 张
                    {raList.length ? ` · 折算 ${renderPageCount(raList)} 页素材展示` : ''}
                  </Text>
                </div>
              ) : null}
            </div>

            {/* 「补充需求与服务资料」9 项（对齐参考站 P2_SALES_FIELDS）。
                默认折叠：九项全不填是常态，铺开占掉半屏反而挤掉真正要填的资料。 */}
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: token.colorTextSecondary, userSelect: 'none' }}>
                补充需求与服务资料（选填）
              </summary>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '6px 0 10px', lineHeight: 1.7 }}>
                填写已有事实，帮助方案解释取舍与服务依据。未知内容留空；参考费用不代替正式报价。
              </Text>
              {SALES_FIELDS.map((f) => (
                <Form.Item key={f.name} label={f.label} name={f.name} extra={f.extra}>
                  <Input.TextArea rows={3} maxLength={2000} placeholder={f.placeholder} />
                </Form.Item>
              ))}
            </details>
          </Form>

          <div style={{ flex: 1, minWidth: 320 }}>
            <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 6 }}>视觉风格</Text>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
              与方案封面图独立；左右滚动预览，点卡片选用
            </Text>
            <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8 }}>
              {PLAN_THEMES.map((s) => {
                const activeSel = style === s.key;
                return (
                  <div
                    key={s.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setStyle(s.key)}
                    onKeyDown={(e) => e.key === 'Enter' && setStyle(s.key)}
                    style={{
                      width: 150,
                      flex: 'none',
                      borderRadius: 12,
                      border: `2px solid ${activeSel ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: token.colorBgContainer,
                      overflow: 'hidden',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ height: 64, background: `url(${s.coverImg}) center/cover`, position: 'relative' }}>
                      <div style={{ position: 'absolute', inset: 0, background: s.cover, opacity: 0.55 }} />
                    </div>
                    <div style={{ padding: '8px 10px' }}>
                      <Text strong style={{ fontSize: 13 }}>
                        {s.key} {s.name}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 11.5, display: 'block', marginTop: 2 }}>
                        {s.desc}
                      </Text>
                    </div>
                  </div>
                );
              })}
            </div>

            <Text strong style={{ display: 'block', fontSize: 15, margin: '18px 0 8px' }}>方案版本</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {EDITIONS.map((v) => {
                const activeSel = version === v.key;
                return (
                  <div
                    key={v.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setVersion(v.key as 'standard' | 'presale' | 'private');
                      if (v.key === 'private') setPageCount(12);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && setVersion(v.key as 'standard' | 'presale' | 'private')}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 12,
                      cursor: 'pointer',
                      border: `2px solid ${activeSel ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: activeSel ? token.colorPrimaryBg : token.colorBgContainer,
                    }}
                  >
                    <Text strong>{v.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{v.desc}</Text>
                  </div>
                );
              })}
            </div>

            <Text strong style={{ display: 'block', fontSize: 15, margin: '18px 0 8px' }}>交付模版：户型图设计</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {FLOORPLAN_TEMPLATES.map((t) => {
                const activeSel = fpTpl === t.key;
                return (
                  <div
                    key={t.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setFpTpl(t.key)}
                    onKeyDown={(e) => e.key === 'Enter' && setFpTpl(t.key)}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 12,
                      cursor: 'pointer',
                      border: `2px solid ${activeSel ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: activeSel ? token.colorPrimaryBg : token.colorBgContainer,
                    }}
                  >
                    <Text strong>{t.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{t.desc}</Text>
                    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>{t.hint}</Text>
                  </div>
                );
              })}
            </div>

            <Text strong style={{ display: 'block', fontSize: 15, margin: '18px 0 8px' }}>交付模版：产品放置</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {MARKER_TEMPLATES.map((m) => {
                const activeSel = mkTpl === m.key;
                return (
                  <div
                    key={m.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setMkTpl(m.key)}
                    onKeyDown={(e) => e.key === 'Enter' && setMkTpl(m.key)}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 12,
                      cursor: 'pointer',
                      border: `2px solid ${activeSel ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: activeSel ? token.colorPrimaryBg : token.colorBgContainer,
                    }}
                  >
                    <Text strong>{m.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{m.desc}</Text>
                    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>{m.hint}</Text>
                  </div>
                );
              })}
            </div>

            <Button
              block
              type="primary"
              loading={savingTpl}
              disabled={!plan}
              onClick={() => void saveTemplates()}
              style={{ marginTop: 12 }}
            >
              保存交付模版
            </Button>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
              模版决定交付 PPT 里户型页怎么画、设备点位怎么标。改完需重新校对才能打包。
            </Text>

            <Text strong style={{ display: 'block', fontSize: 15, margin: '18px 0 8px' }}>方案页数</Text>
            <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
              {pageChoices.map((n) => {
                const activeSel = pageCount === n && !customPages;
                return (
                  <div
                    key={n}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setPageCount(n); setCustomPages(false); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setPageCount(n); setCustomPages(false); } }}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '10px 0',
                      borderRadius: 12,
                      cursor: 'pointer',
                      fontWeight: 700,
                      border: `2px solid ${activeSel ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: activeSel ? token.colorPrimaryBg : token.colorBgContainer,
                    }}
                  >
                    {n} 页
                  </div>
                );
              })}
              <div
                role="button"
                tabIndex={0}
                onClick={() => { setCustomPages(true); setPageCount(customValue); }}
                onKeyDown={(e) => e.key === 'Enter' && setCustomPages(true)}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '10px 0',
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontWeight: 700,
                  border: `2px solid ${customPages ? token.colorPrimary : token.colorBorderSecondary}`,
                  background: customPages ? token.colorPrimaryBg : token.colorBgContainer,
                }}
              >
                自定义
              </div>
            </div>
            {customPages ? (
              <div style={{ marginTop: 10 }}>
                {/* 刻意不用 InputNumber 的 min/max：它会静默拦掉越界输入 ——
                    实测输 25 会被悄悄退回 9，用户看不到发生了什么。
                    这里让任意数字都能进来，再由 onChange 可见地夹取（输 25 → 立刻变 20）。 */}
                <InputNumber
                  value={customValue}
                  parser={(v) => (v === '' ? '' : Number(String(v).replace(/[^\d]/g, '')))}
                  formatter={(v) => `${v}`.replace(/[^\d]/g, '')}
                  onChange={(v) => {
                    const n = Math.max(CORE_MODULES, Math.min(PAGE_COUNT_MAX, Number(v ?? CORE_MODULES) || CORE_MODULES));
                    setCustomValue(n);
                    setPageCount(n);
                  }}
                  addonAfter={`页（可填 ${CORE_MODULES} ~ ${PAGE_COUNT_MAX}）`}
                  style={{ width: '100%' }}
                />
              </div>
            ) : null}
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8, lineHeight: 1.7 }}>
              {budget.formula}
              <br />
              {budget.expansion}；{budget.cost}（单价由部署者按画质配置）。
              {materials.floorplanCount > 1 || materials.renderCount > 0 ? (
                <>
                  <br />
                  素材页来自你上传的户型图与效果图本身，不再单独计生成费。
                </>
              ) : null}
            </Text>
          </div>
        </div>
      ) : null}

      {/* 步骤 2：逐页审稿（幻灯片缩略图 + 文字卡片） */}
      {step === 1 && plan ? (
        <>
          {/* 页数摘要状态条（参考站 A2 / app:3380-3384）：
              审稿页最该看清的就是「这份方案够不够页、会不会交付时缩水」。
              第 1 步的核算提示管的是生成前，这里管的是交付前，两处都必要。 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              marginBottom: 16,
              padding: '10px 14px',
              background: token.colorFillQuaternary,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 12,
            }}
          >
            <FileTextOutlined style={{ color: token.colorTextTertiary }} />
            <Text style={{ fontSize: 13 }}>
              共 <Text strong>{view.pages.length}</Text> 页
              {materialMin > view.pages.length ? (
                <Text type="warning">（素材下限 ${materialMin} 页，当前不足）</Text>
              ) : (
                <Text type="secondary">（素材下限 ${materialMin} 页，已达标）</Text>
              )}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              上限 {PAGE_COUNT_MAX} 页
            </Text>
            <div style={{ flex: 1 }} />
            {/* 完整文案与逐页视图并存（参考站 A3）：门店审稿时需要通读一遍看前后是否连贯，
                逐页卡片看不出这一点。只读而非可编辑 —— 我方按单页 PATCH 且每次 bump 版本号，
                整篇保存会绕过这道版本控制，两份内容很容易互相覆盖。 */}
            <Button size="small" icon={<FileTextOutlined />} onClick={() => setDeckTextOpen((v) => !v)}>
              {deckTextOpen ? '收起完整文案' : '查看完整文案'}
            </Button>
          </div>
          {deckTextOpen ? (
            <div
              style={{
                marginBottom: 16,
                padding: '16px 20px',
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 14,
                maxHeight: 420,
                overflowY: 'auto',
                lineHeight: 1.9,
                whiteSpace: 'pre-wrap',
              }}
            >
              <Text style={{ fontSize: 13.5 }}>{buildNarrationText(exportPayload(plan))}</Text>
            </div>
          ) : null}
        </>
      ) : null}

      {step === 1 && plan ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {view.pages.map((p, i) => (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => startEdit(realIndexOf(i), p)}
              onKeyDown={(e) => e.key === 'Enter' && startEdit(realIndexOf(i), p)}
              style={{
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 16,
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <div style={{ padding: '10px 10px 0' }}>
                <PlanSlide page={p} index={i} plan={slidePlan} t={t} listNo={floorplanListPageNo(view.pages, i)} />
              </div>
              <div style={{ padding: '12px 16px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Tag style={{ margin: 0, borderRadius: 9999, background: token.colorFillTertiary, color: token.colorTextSecondary, border: 'none' }}>
                    {String(i + 1).padStart(2, '0')} {PAGE_TYPE_LABEL[p.type]}
                  </Tag>
                  <div style={{ flex: 1 }} />
                  <EditOutlined style={{ color: token.colorTextTertiary }} />
                </div>
                <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 6 }}>
                  {p.heading}
                </Text>
                <Text style={{ fontSize: 12.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', color: token.colorTextSecondary }}>
                  {p.body}
                </Text>
                {p.bullets.length > 0 ? (
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                    {p.bullets.length} 条要点 · 含讲解稿
                  </Text>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* 步骤 3：生成与校对（左页列表 + 右幻灯片预览） */}
      {step === 2 && plan && active ? (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <div style={{ width: 300, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {view.pages.map((p, i) => (
              <div
                key={i}
                role="button"
                tabIndex={0}
                onClick={() => setActivePage(i)}
                onKeyDown={(e) => e.key === 'Enter' && setActivePage(i)}
                style={{
                  padding: '12px 16px',
                  borderRadius: 12,
                  cursor: 'pointer',
                  background: activePage === i ? token.colorPrimaryBg : token.colorBgContainer,
                  border: `1px solid ${activePage === i ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                }}
              >
                <Text strong style={{ fontSize: 13.5, display: 'block' }}>
                  {String(i + 1).padStart(2, '0')} {PAGE_TYPE_LABEL[p.type]}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: p.heading }}>
                  {p.heading}
                </Text>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 360 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
              <Text strong style={{ fontSize: 15, flex: 1 }}>
                第 {activePage + 1} 页 · {PAGE_TYPE_LABEL[active.type]}
              </Text>
              {/* 户型图+布点入口：始终可见（0.1.37 入口拓宽：与当前页无关，方便逐页审稿前/后随时上传） */}
              <Button
                size="small"
                type={plan.floorplanAssetId ? 'default' : 'primary'}
                ghost
                style={{ marginRight: 8 }}
                onClick={() => navigate(`/device-layout?planId=${plan.id}`)}
              >
                {plan.floorplanAssetId && plan.layoutPoints?.length
                  ? `已布 ${plan.layoutPoints.length} 个点位 · 重新布点`
                  : plan.floorplanAssetId
                    ? '户型图已上传 · 布点'
                    : '上传平面图 · 布点'}
              </Button>
              {/* 精装修生成：必须先有户型图，无则禁用 */}
              <Button
                size="small"
                ghost
                type={plan.renderedFloorplanAssetId ? 'default' : 'primary'}
                disabled={!plan.floorplanAssetId || renderingFloorplan}
                loading={renderingFloorplan}
                style={{ marginRight: 8 }}
                onClick={renderFloorplan}
              >
                {plan.renderedFloorplanAssetId ? '重新生成精装修' : '生成精装修效果图'}
              </Button>
              <Button size="small" icon={<EditOutlined />} onClick={() => startEdit(realIndexOf(activePage), active)}>
                修改当前页
              </Button>
            </div>
            <PlanSlide page={active} index={activePage} plan={slidePlan} t={t} listNo={floorplanListPageNo(view.pages, activePage)} />
            <div style={{ marginTop: 12 }}>
              <Button size="small" type="text" onClick={() => setShowNarration(!showNarration)}>
                {showNarration ? '▾' : '▸'} 本页讲解稿（客户阅读模式不显示）
              </Button>
              {showNarration ? (
                <div style={{ marginTop: 8, padding: '12px 14px', background: token.colorFillQuaternary, borderRadius: 10, fontSize: 13, lineHeight: 1.8, color: token.colorTextSecondary }}>
                  {active.narration || '（本页暂无讲解稿）'}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* 步骤 4：交付客户 */}
      {step === 3 && plan ? (
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div style={{ background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 20, padding: '36px 32px', textAlign: 'center' }}>
            <Title level={4} style={{ marginTop: 0 }}>最终交付客户</Title>
            <Text type="secondary">逐页确认内容后，下载或分享完整版本。</Text>
            {/* 校对状态常驻显示：改一个字就会自动失效，不该让用户点导出才知道白点了 */}
            <div style={{ marginTop: 12 }}>
              {plan.reviewed ? (
                <Tag color="success" icon={<CheckCircleOutlined />}>本版已逐页校对（V{plan.versionNo}）</Tag>
              ) : (
                <Tag color="warning" icon={<ExclamationCircleOutlined />}>本版尚未校对，导出与分享时会提示确认</Tag>
              )}
            </div>
            {/* 交付前预检（参考站 preflight-content）：逐页点名「还有内部语句」。
                不静默净化 —— 静默处理会让人以为系统吃了内容；也不硬拦 ——
                门店有权决定改还是删，位置必须先报出来。 */}
            <div style={{ marginTop: 16, textAlign: 'left' }}>
              {preflight === null ? (
                <Text type="secondary" style={{ fontSize: 12 }}>正在检查是否还有「待确认」这类内部语句…</Text>
              ) : preflight.warnings.length === 0 ? (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  交付前检查通过：{preflight.pageCount} 页均无内部待办语句
                </Tag>
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  message={`第 ${preflight.warnings.length} 处内部待办语句，打包交付前建议先处理`}
                  description={
                    <div style={{ maxHeight: 200, overflowY: 'auto', lineHeight: 1.9 }}>
                      {preflight.warnings.map((w, i) => (
                        <div key={`${w.index}-${w.field}-${i}`}>
                          第 {w.index + 1} 页 · {FIELD_LABEL[w.field] ?? w.field}：{w.snippet}
                        </div>
                      ))}
                    </div>
                  }
                />
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
              <Button type="primary" size="large" icon={<DownloadOutlined />} loading={packaging} onClick={packageDelivery} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 190 }}>
                打包交付三件套
              </Button>
              <Button size="large" icon={<DownloadOutlined />} loading={exporting} onClick={downloadPptx}>
                只下载 PPTX
              </Button>
              <Button size="large" icon={<FileTextOutlined />} onClick={downloadScript}>
                只下载讲稿
              </Button>
              <Button size="large" icon={<FullscreenOutlined />} onClick={() => setReaderOpen(true)}>
                全屏播放
              </Button>
              <Button size="large" icon={<PlayCircleOutlined />} onClick={() => void openVidPicker()}>
                {boundVideos.length ? `场景视频（已绑 ${boundVideos.length} 条）` : '绑定场景视频'}
              </Button>
              <Button size="large" icon={<LinkOutlined />} onClick={() => requireReview(() => void copyLink())}>
                复制分享链接
              </Button>
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              交付三件套 = 方案 PPTX + 完整讲稿 + 图片包（户型图与效果图原图），打成一个 zip 发给客户。
              图片包由服务端按方案素材自动收集，不用自己整理；链接 2 小时内有效，方案改版后自动失效。
            </Text>
            <div
              style={{
                margin: '22px auto 0',
                maxWidth: 560,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 12,
                padding: '10px 14px',
              }}
            >
              <LinkOutlined style={{ color: token.colorTextTertiary }} />
              <Text style={{ flex: 1, textAlign: 'left', fontSize: 13, wordBreak: 'break-all' }}>{shareUrl}</Text>
              <Button size="small" href={shareUrl} target="_blank">客户视角</Button>
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 14 }}>
              分享链接展示已确认的完整版本（{view.pages.length} 页 · 文案版本 {plan.versionNo}）。修改方案后，重新打开分享即为客户看到的最新版本。
            </Text>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              全屏播放支持 ← → 翻页、Home / End 跳首尾、F 切换全屏、Esc 退出。
            </Text>
          </div>
        </div>
      ) : null}

      {generating ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">AI 正在撰写方案文案（约 1-2 分钟），完成后进入逐页审稿…</Text>
          </div>
        </div>
      ) : null}

      {/* 底部按钮 */}
      {!generating ? (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 28 }}>
          {step > 0 ? (
            <Button size="large" onClick={() => setStep(step - 1)} disabled={!plan}>上一步</Button>
          ) : null}
          {step === 0 ? (
            <Button data-testid="plan-generate-btn" size="large" type="primary" loading={generating} onClick={generate} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 180 }}>
              生成方案文案
            </Button>
          ) : step < STEPS.length - 1 ? (
            <Button data-testid="goto-delivery-btn" size="large" type="primary" onClick={() => { if (plan) void runPreflight(plan.id); setStep(step + 1); }} disabled={!plan} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 160 }}>
              {step === 1 ? '生成与校对' : '进入交付'}
            </Button>
          ) : (
            <Button size="large" type="primary" onClick={downloadPptx} loading={exporting} disabled={!plan} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 180 }}>
              下载方案 PPTX
            </Button>
          )}
        </div>
      ) : null}

      {/* 逐页编辑弹窗 */}
      <Modal
        open={editing !== null}
        title={`编辑 ${editing !== null ? PAGE_TYPE_LABEL[plan?.pages[editing.index].type ?? 'scene'] : ''} ${String((editing?.index ?? 0) + 1).padStart(2, '0')}`}
        onCancel={() => setEditing(null)}
        onOk={savePage}
        okText="保存本页"
        confirmLoading={savingPage}
        width={680}
      >
        {editing ? (
          (() => {
            // 条数上限取自渲染侧的同一张表，超出的不会显示——当场说明比存完再让用户纳闷好
            const limit = PAGE_BULLET_LIMIT[plan?.pages[editing.index].type ?? 'scene'] ?? 5;
            const lines = editing.bullets.split(/\r?\n/).filter((l) => l.trim());
            const over = lines.length - limit;
            return (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>页标题</Text>
                <Input value={editing.heading} onChange={(e) => setEditing({ ...editing, heading: e.target.value })} maxLength={200} style={{ marginBottom: 14 }} />
                <Text strong style={{ display: 'block', marginBottom: 6 }}>副标题</Text>
                <Input value={editing.subtitle} onChange={(e) => setEditing({ ...editing, subtitle: e.target.value })} maxLength={200} style={{ marginBottom: 14 }} />
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Text strong>页面要点（一行一条）</Text>
                  <Text type={over > 0 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                    {over > 0 ? `超出的 ${over} 条不会显示` : `${lines.length} / 最多显示 ${limit} 条`}
                  </Text>
                </div>
                <Input.TextArea
                  rows={Math.min(8, Math.max(3, lines.length + 1))}
                  value={editing.bullets}
                  onChange={(e) => setEditing({ ...editing, bullets: e.target.value })}
                  placeholder={'如：\n全屋 200+ 子设备稳定接入\n灯光支持调光调色与场景联动\n安防与门锁联动，开门自动开灯'}
                  style={{ marginBottom: 14 }}
                />
                <Text strong style={{ display: 'block', marginBottom: 6 }}>正文文案</Text>
                <Input.TextArea rows={5} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} maxLength={8000} showCount style={{ marginBottom: 14 }} />
                <Text strong style={{ display: 'block', marginBottom: 6 }}>底部引言（一页一句价值收束语）</Text>
                <Input value={editing.quote} onChange={(e) => setEditing({ ...editing, quote: e.target.value })} maxLength={300} style={{ marginBottom: 14 }} />
                <Text strong style={{ display: 'block', marginBottom: 6 }}>本页讲解稿（销售当面讲解用，客户阅读模式不显示）</Text>
                <Input.TextArea rows={4} value={editing.narration} onChange={(e) => setEditing({ ...editing, narration: e.target.value })} maxLength={8000} />
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="保存后分享页与导出会自动剔除「待确认 / 暂无 / TBD」这类内部语句"
                />
              </div>
            );
          })()
        ) : null}
      </Modal>

      {/* 交付前的校对门：未确认时拦一下，确认后自动执行原本要做的动作 */}
      <Modal
        open={reviewOpen}
        title="交付前请确认"
        onCancel={() => { setReviewOpen(false); setPendingAction(null); }}
        onOk={() => void confirmReview()}
        okText="我已逐页校对，继续"
        okButtonProps={{ disabled: !reviewChecked }}
        cancelText="取消"
        width={520}
      >
        <div style={{ lineHeight: 1.9 }}>
          <Text>
            这份方案当前是 <Text strong>V{plan?.versionNo ?? 0}</Text> 版，
            共 {plan?.pages.length ?? 0} 页。<Text strong>导出与分享前请先逐页过一遍</Text>，
            确认没有「待确认 / 暂无 / TBD」这类内部语句。
          </Text>
          <Alert
            type="warning"
            showIcon
            style={{ margin: '12px 0' }}
            message="确认只对当前版本有效"
            description="之后再改任何一页的文案，这个确认会自动失效，需要重新确认一次。"
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={reviewChecked} onChange={(e) => setReviewChecked(e.target.checked)} />
            <span>我已逐页校对这份方案，可以交付客户</span>
          </label>
        </div>
      </Modal>

      {/* 从「我的资料」选效果图：与生图页选参考图同源，资料库里的图直接挂 id 不重复上传 */}
      <Modal
        open={raPickerOpen}
        title="从「我的资料」选择装修效果图"
        onCancel={() => { setRaPickerOpen(false); setLibPicked([]); }}
        onOk={() => addFromLibrary()}
        okText={`添加 ${libPicked.length} 张`}
        okButtonProps={{ disabled: !libPicked.length }}
        cancelText="取消"
        width={760}
        destroyOnHidden
      >
        {libLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin /></div>
        ) : libAssets.length === 0 ? (
          <Empty description="资料库里还没有图片，先去「AI 生图」生成，或直接上传效果图文件" />
        ) : (
          <>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
              点选后可添加多张，还能再追加。同一空间的多张图会合成一页展示。
            </Text>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, maxHeight: 420, overflowY: 'auto' }}>
              {libAssets.map((a) => {
                const added = raList.some((x) => x.assetId === a.id);
                const picked = libPicked.includes(a.id);
                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={picked}
                    onClick={() => {
                      if (added) return;
                      setLibPicked((prev) => (picked ? prev.filter((x) => x !== a.id) : [...prev, a.id]));
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || added) return;
                      setLibPicked((prev) => (picked ? prev.filter((x) => x !== a.id) : [...prev, a.id]));
                    }}
                    style={{
                      cursor: added ? 'not-allowed' : 'pointer',
                      position: 'relative',
                      border: `1px solid ${picked ? token.colorPrimary : token.colorBorderSecondary}`,
                      borderRadius: 10,
                      overflow: 'hidden',
                      opacity: added ? 0.45 : 1,
                    }}
                  >
                    <img
                      src={fileUrl(`/api/media/assets/${a.id}/file`)}
                      alt={a.title}
                      loading="lazy"
                      style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }}
                    />
                    <div style={{ padding: '6px 8px', fontSize: 12 }}>{a.title}</div>
                    {picked ? (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: token.colorPrimary, color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✓</div>
                    ) : null}
                    {added ? (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.45)', color: '#fff', fontSize: 12 }}>已在本方案</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>

      {/* 绑定场景视频：只列已生成的视频。刻意不做「在方案页现场生视频」——
          模型是客户自备的，现场生要消耗额度且慢；先用「AI 生视频」出好片再挂进来。 */}
      <Modal
        open={vidPickerOpen}
        title="从「我的资料」选择场景视频（最多 2 条）"
        onCancel={() => setVidPickerOpen(false)}
        onOk={() => void bindVideos()}
        okText={`绑定 ${Math.min(vidPicked.length, 2)} 条`}
        okButtonProps={{ disabled: !vidPicked.length }}
        cancelText="取消"
        width={760}
      >
        {vidAssets.length === 0 ? (
          <Empty description="资料库里还没有视频。先去「AI 生视频」生成，再回来绑定" />
        ) : (
          <>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
              视频会放在分享页最前面，客户在微信里打开先看到画面，再看逐页文案。
            </Text>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, maxHeight: 380, overflowY: 'auto' }}>
              {vidAssets.map((a) => {
                const picked = vidPicked.includes(a.id);
                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={picked}
                    onClick={() => setVidPicked((prev) => (picked ? prev.filter((x) => x !== a.id) : prev.length < 2 ? [...prev, a.id] : prev))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      setVidPicked((prev) => (picked ? prev.filter((x) => x !== a.id) : prev.length < 2 ? [...prev, a.id] : prev));
                    }}
                    style={{
                      cursor: 'pointer',
                      position: 'relative',
                      border: `1px solid ${picked ? token.colorPrimary : token.colorBorderSecondary}`,
                      borderRadius: 10,
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ height: 96, background: token.colorFillTertiary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>
                      <PlayCircleOutlined style={{ fontSize: 28 }} />
                    </div>
                    <div style={{ padding: '6px 8px', fontSize: 12 }}>{a.title}</div>
                    {picked ? (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: token.colorPrimary, color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✓</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>

      {/* 方案全屏阅读器（演示模式）：逐页渲染复用 PlanSlide */}
      {readerOpen && plan && plan.pages.length > 0 ? (
        <PlanReader pages={plan.pages} slidePlan={slidePlan} t={t} onClose={() => setReaderOpen(false)} />
      ) : null}

      {/* 历史方案抽屉 */}
      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="历史方案" width={440}>
        {history.length === 0 ? (
          <Text type="secondary">暂无历史方案</Text>
        ) : (
          history.map((h) => (
            <div
              key={h.id}
              style={{ padding: '12px 0', borderBottom: `1px solid ${token.colorBorderSecondary}`, display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text strong style={{ display: 'block' }} ellipsis={{ tooltip: h.title }}>{h.title}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {h.customer || '未填客户'} · {h.area || '未填面积'} · {h.pageCount} 页文案 · 版本 {h.versionNo} · {h.updatedAt.slice(5, 16).replace('T', ' ')}
                </Text>
              </div>
              <Button size="small" onClick={() => void openPlan(h.id)}>打开</Button>
              <Popconfirm
                title="删除后分享链接立即失效，确定？"
                onConfirm={async () => {
                  try {
                    await api(`/api/plans/${h.id}`, { method: 'DELETE' });
                    void loadHistory();
                    message.success('已删除');
                  } catch (e) {
                    message.error((e as Error).message || '删除失败');
                  }
                }}
              >
                <Button size="small" danger type="text">删除</Button>
              </Popconfirm>
            </div>
          ))
        )}
      </Drawer>
    </div>
  );
}

/* ---------- 方案全屏阅读器（演示模式） ---------- */

/** PlanSlide 的 plan 入参形状（镜像其内部类型，避免依赖未导出的声明） */
interface ReaderSlidePlan {
  store: string;
  floorplanUrl?: string | null;
  renderedFloorplanUrl?: string | null;
  layoutPoints?: { name: string; category: string; x: number; y: number }[] | null;
}

/** 跟随系统「减少动态效果」偏好，并在偏好变化时实时更新 */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => setReduce(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return reduce;
}

/**
 * 方案全屏阅读器（演示模式）：
 * - 每页直接复用 PlanSlide 渲染，不另写一套页面渲染逻辑
 * - 键盘：← → 翻页，Home / End 跳首尾，F 切浏览器全屏，Esc 退出
 * - 翻页过渡用 Web Animations API（200ms 淡入 + 24px 横向位移，方向决定符号）；
 *   系统开启「减少动态效果」时整段动画与控制条淡入淡出都跳过，只做瞬时切换
 * - 鼠标移动/触摸唤醒控制条，静止 2.5 秒后淡出；键盘翻页同样唤醒，保证随时可操作
 */
function PlanReader({
  pages,
  slidePlan,
  t,
  onClose,
}: {
  pages: PlanPage[];
  slidePlan: ReaderSlidePlan;
  t: PlanTheme;
  onClose: () => void;
}): ReactNode {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<Animation | null>(null);
  const hideTimer = useRef<number | null>(null);
  const screens = Grid.useBreakpoint();
  const isNarrow = screens.md === false;
  const reduceMotion = usePrefersReducedMotion();
  const total = pages.length;

  // 打开时锁定背景滚动；关闭时若仍在全屏则退出，避免把页面留在全屏态
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  // 唤醒控制条，静止 2.5 秒后淡出
  const wake = useCallback((): void => {
    setChrome(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 2500);
  }, []);
  useEffect(() => {
    wake();
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [wake]);

  const go = useCallback(
    (next: number, direction: number): void => {
      setDir(direction >= 0 ? 1 : -1);
      setIndex(Math.min(total - 1, Math.max(0, next)));
      wake();
    },
    [total, wake],
  );
  const move = useCallback((delta: number): void => go(index + delta, delta), [go, index]);
  const jump = useCallback((i: number): void => go(i, i >= index ? 1 : -1), [go, index]);

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // 浏览器可能因缺少用户手势拒绝全屏；页内浮层本身已是全视口，直接忽略
    }
  }, []);
  useEffect(() => {
    const sync = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // 键盘操作：焦点在输入框内或带修饰键时不拦截
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); move(1); break;
        case 'ArrowLeft': e.preventDefault(); move(-1); break;
        case 'Home': e.preventDefault(); jump(0); break;
        case 'End': e.preventDefault(); jump(total - 1); break;
        case 'Escape': e.preventDefault(); onClose(); break;
        case 'f':
        case 'F': e.preventDefault(); void toggleFullscreen(); break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, total, move, jump, toggleFullscreen, onClose]);

  // 翻页过渡：淡入 + 横向位移，快速连按时先取消上一段动画，避免叠加
  useEffect(() => {
    const el = stageRef.current;
    if (!el || reduceMotion) return;
    animRef.current?.cancel();
    animRef.current = el.animate(
      [
        { opacity: 0, transform: `translateX(${dir * 24}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 200, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    );
  }, [index, dir, reduceMotion]);
  useEffect(() => () => { animRef.current?.cancel(); }, []);

  const page = pages[index];
  if (!page) return null;
  const chromeStyle: CSSProperties = {
    opacity: chrome ? 1 : 0,
    pointerEvents: chrome ? 'auto' : 'none',
    transition: reduceMotion ? 'none' : 'opacity 220ms ease',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`方案全屏阅读器，第 ${index + 1} 页，共 ${total} 页`}
      onMouseMove={wake}
      onTouchStart={wake}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: '#0b0c0e',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 顶栏：页型与标题 + 页码 + 全屏/退出 */}
      <div
        style={{
          ...chromeStyle,
          display: 'flex',
          alignItems: 'center',
          gap: isNarrow ? 6 : 12,
          padding: isNarrow ? '8px 10px' : '12px 20px',
          flexWrap: 'wrap',
        }}
      >
        <Text
          style={{
            flex: 1,
            minWidth: 120,
            color: '#ffffffd9',
            fontSize: isNarrow ? 13 : 15,
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {PAGE_TYPE_LABEL[page.type]} · {page.heading}
        </Text>
        <Text style={{ color: '#ffffffa6', fontSize: isNarrow ? 12 : 13, fontVariantNumeric: 'tabular-nums' }}>
          {index + 1} / {total}
        </Text>
        <Button
          size={isNarrow ? 'small' : undefined}
          icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          title="全屏切换（F）"
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? '退出全屏' : '全屏'}
        </Button>
        <Button size={isNarrow ? 'small' : undefined} icon={<CloseOutlined />} onClick={onClose}>
          退出
        </Button>
      </div>

      {/* 舞台：页内容（PlanSlide 内部按 cqw 自适应缩放，窄屏无需额外适配） */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isNarrow ? 8 : 20, overflow: 'hidden' }}>
        <div ref={stageRef} style={{ width: '100%', maxWidth: isNarrow ? '100%' : 1280, willChange: 'transform, opacity' }}>
          <PlanSlide page={page} index={index} plan={slidePlan} t={t} listNo={floorplanListPageNo(pages, index)} />
        </div>
      </div>

      {/* 底栏：上一页/下一页 + 可点页码圆点 + 快捷键提示 */}
      <div
        style={{
          ...chromeStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: isNarrow ? 6 : 12,
          padding: isNarrow ? '8px 10px 12px' : '12px 20px 18px',
          flexWrap: 'wrap',
        }}
      >
        <Button size={isNarrow ? 'small' : undefined} icon={<LeftOutlined />} disabled={index === 0} onClick={() => move(-1)}>
          上一页
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: isNarrow ? 5 : 8, flexWrap: 'wrap' }}>
          {pages.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-label={`第 ${i + 1} 页 ${PAGE_TYPE_LABEL[p.type]}`}
              aria-current={i === index}
              onClick={() => jump(i)}
              style={{
                width: isNarrow ? 8 : 10,
                height: isNarrow ? 8 : 10,
                padding: 0,
                border: 'none',
                borderRadius: '50%',
                cursor: 'pointer',
                background: i === index ? '#ffffff' : '#ffffff59',
                transform: i === index ? 'scale(1.25)' : undefined,
                transition: reduceMotion ? 'none' : 'background 180ms ease, transform 180ms ease',
              }}
            />
          ))}
        </div>
        <Button size={isNarrow ? 'small' : undefined} disabled={index >= total - 1} onClick={() => move(1)}>
          下一页 <RightOutlined />
        </Button>
        <Text style={{ width: '100%', textAlign: 'center', color: '#ffffff73', fontSize: 12, marginTop: 4 }}>
          ← → 翻页 · Home / End 首尾 · F 全屏 · Esc 退出
        </Text>
      </div>
    </div>
  );
}
