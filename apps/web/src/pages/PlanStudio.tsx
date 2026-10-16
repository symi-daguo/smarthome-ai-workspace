import {
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  LeftOutlined,
  LinkOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Alert, App as AntApp, Button, Drawer, Form, Grid, Input, InputNumber, Modal, Popconfirm, Progress, Space, Spin, Steps, Tag, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, fileUrl } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';
import { PLAN_THEMES, PAGE_TYPE_LABEL, planTheme, type PlanPage, type PlanTheme } from '../data/planThemes';
import { exportPlanPptx, buildNarrationText } from '../lib/planPptx';
import { PlanSlide, PAGE_BULLET_LIMIT } from '../components/PlanSlide';

const { Text, Title } = Typography;

const STEPS = ['客户资料', '逐页审稿', '生成与校对', '交付客户'];

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
  pageCount: number;
  pages: PlanPage[];
  versionNo: number;
  shareToken: string;
  updatedAt: string;
  floorplanAssetId?: string | null;
  /** AI 渲染的精装修效果图（基于客户户型图按方案风格+生态生成） */
  renderedFloorplanAssetId?: string | null;
  layoutPoints?: { name: string; category: string; x: number; y: number }[] | null;
}

interface PlanListItem {
  id: string;
  title: string;
  customer: string;
  area: string;
  style: string;
  edition: string;
  pageCount: number;
  versionNo: number;
  shareToken: string;
  updatedAt: string;
}

export function PlanStudio(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  // 窄屏只在首屏渲染前为 undefined，取 false 表示先按宽屏排版，避免列先出现再消失
  const isNarrow = screens.md === false;
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState('A');
  const [version, setVersion] = useState<'standard' | 'presale' | 'private'>('standard');
  const [pageCount, setPageCount] = useState(9);
  const [form] = Form.useForm();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [generating, setGenerating] = useState(false);
  /** 提交幂等键：失败保留、成功清除，详见 lib/request-id.ts */
  const reqIdRef = useRef<string | null>(null);
  // 编辑中的那一页。bullets 用纯文本存（一行一条），保存时再拆成数组——
// 用户手上通常就是一段多行文案，让他对着 JSON 数组改是不合理的
const [editing, setEditing] = useState<{
    index: number; heading: string; subtitle: string; bullets: string; body: string; narration: string; quote: string;
  } | null>(null);
  const [savingPage, setSavingPage] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PlanListItem[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [showNarration, setShowNarration] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
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
        setPageCount(detail.pageCount);
        setActivePage(0);
        setStep(1);
      })
      .catch(() => {
        message.error('方案打开失败，可能已被删除');
      });
  }, [planId]);

  const generate = async (): Promise<void> => {
    let values: Record<string, string>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
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
          style,
          edition: version,
          pageCount,
          clientRequestId: rid,
        }),
      });
      reqIdRef.current = null;
      setPlan(created);
      setStep(1);
      message.success(
        created.deduped
          ? '这次提交此前已生成过方案，直接取回原方案（未重复扣额度）'
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
    setEditing({
      index,
      heading: p.heading,
      subtitle: p.subtitle ?? '',
      // bullets 是数组，编辑时按行拆成纯文本——用户手上是一段多行文案，不是 JSON
      bullets: (p.bullets ?? []).join('\n'),
      body: p.body,
      narration: p.narration,
      quote: p.quote ?? '',
    });
  };

  const savePage = async (): Promise<void> => {
    if (!editing || !plan) return;
    setSavingPage(true);
    try {
      const updated = await api<PlanDetail>(`/api/plans/${plan.id}/pages/${editing.index}`, {
        method: 'PATCH',
        body: JSON.stringify({
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
      message.success(`已保存，文案版本 ${updated.versionNo}`);
    } catch (e) {
      message.error((e as Error).message || '保存失败');
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
      setPageCount(detail.pageCount);
      setStep(1);
      setHistoryOpen(false);
    } catch (e) {
      message.error((e as Error).message || '打开失败');
    }
  };

  const shareUrl = plan ? `${window.location.origin}/share/plan/${plan.shareToken}` : '';

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      message.success('分享链接已复制，发给客户微信打开即可');
    } catch {
      modal.info({ title: '分享链接', content: shareUrl });
    }
  };

  const downloadPptx = async (): Promise<void> => {
    if (!plan) return;
    setExporting(true);
    try {
      await exportPlanPptx({
        ...plan,
        floorplanUrl: plan.floorplanAssetId ? fileUrl(`/api/media/assets/${plan.floorplanAssetId}/file`) : null,
        renderedFloorplanUrl: plan.renderedFloorplanAssetId ? fileUrl(`/api/media/assets/${plan.renderedFloorplanAssetId}/file`) : null,
        layoutPoints: plan.layoutPoints ?? null,
      });
      message.success('PPTX 已下载（16:9 原生幻灯片，可直接编辑）');
    } catch (e) {
      message.error((e as Error).message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

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

  const downloadScript = (): void => {
    if (!plan) return;
    const blob = new Blob([buildNarrationText(plan)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.title}-完整讲稿.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const reset = (): void => {
    setPlan(null);
    setStep(0);
    setActivePage(0);
    setSplitOverride({});
    form.resetFields();
  };

  const t = planTheme(plan?.style ?? style);
  const active = plan?.pages[activePage];
  // 幻灯片 plan 视图：带户型图与点位（空间动线页配图）
  const slidePlan = {
    store: plan?.store ?? '',
    floorplanUrl: plan?.floorplanAssetId ? fileUrl(`/api/media/assets/${plan.floorplanAssetId}/file`) : null,
    renderedFloorplanUrl: plan?.renderedFloorplanAssetId ? fileUrl(`/api/media/assets/${plan.renderedFloorplanAssetId}/file`) : null,
    layoutPoints: plan?.layoutPoints ?? null,
  };
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

            <Text strong style={{ display: 'block', fontSize: 15, margin: '18px 0 8px' }}>方案页数</Text>
            <div style={{ display: 'flex', gap: 10 }}>
              {[9, 10, 12].map((n) => {
                const activeSel = pageCount === n;
                return (
                  <div
                    key={n}
                    role="button"
                    tabIndex={0}
                    onClick={() => setPageCount(n)}
                    onKeyDown={(e) => e.key === 'Enter' && setPageCount(n)}
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
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              {pageCount} 个沟通模块，按额度扣费（单价由部署者配置）。
            </Text>
          </div>
        </div>
      ) : null}

      {/* 步骤 2：逐页审稿（幻灯片缩略图 + 文字卡片） */}
      {step === 1 && plan ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {plan.pages.map((p, i) => (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => startEdit(i, p)}
              onKeyDown={(e) => e.key === 'Enter' && startEdit(i, p)}
              style={{
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 16,
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <div style={{ padding: '10px 10px 0' }}>
                <PlanSlide page={p} index={i} plan={slidePlan} t={t} />
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
            {plan.pages.map((p, i) => (
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
              <Button size="small" icon={<EditOutlined />} onClick={() => startEdit(activePage, active)}>
                修改当前页
              </Button>
            </div>
            <PlanSlide page={active} index={activePage} plan={slidePlan} t={t} />
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
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
              <Button type="primary" size="large" icon={<DownloadOutlined />} loading={exporting} onClick={downloadPptx} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 160 }}>
                下载方案 PPTX
              </Button>
              <Button size="large" icon={<FileTextOutlined />} onClick={downloadScript}>
                下载完整讲稿
              </Button>
              <Button size="large" icon={<FullscreenOutlined />} onClick={() => setReaderOpen(true)}>
                全屏播放
              </Button>
              <Button size="large" icon={<LinkOutlined />} onClick={copyLink}>
                复制分享链接
              </Button>
            </div>
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
              分享链接展示已确认的完整版本（{plan.pages.length} 页 · 文案版本 {plan.versionNo}）。修改方案后，重新打开分享即为客户看到的最新版本。
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
            <Button size="large" type="primary" loading={generating} onClick={generate} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 180 }}>
              生成方案文案
            </Button>
          ) : step < STEPS.length - 1 ? (
            <Button size="large" type="primary" onClick={() => setStep(step + 1)} disabled={!plan} style={{ background: BRAND_GRADIENT, border: 'none', minWidth: 160 }}>
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
                  {h.customer || '未填客户'} · {h.area || '未填面积'} · {h.pageCount} 页 · 版本 {h.versionNo} · {h.updatedAt.slice(5, 16).replace('T', ' ')}
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
          <PlanSlide page={page} index={index} plan={slidePlan} t={t} />
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
