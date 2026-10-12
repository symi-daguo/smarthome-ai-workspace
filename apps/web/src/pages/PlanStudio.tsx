import {
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  LeftOutlined,
  LinkOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { App as AntApp, Button, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Spin, Steps, Tag, Typography, theme } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, fileUrl } from '../lib/api';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';
import { PLAN_THEMES, PAGE_TYPE_LABEL, planTheme, type PlanPage } from '../data/planThemes';
import { exportPlanPptx, buildNarrationText } from '../lib/planPptx';
import { PlanSlide } from '../components/PlanSlide';

const { Text, Title } = Typography;

const STEPS = ['客户资料', '逐页审稿', '生成与校对', '交付客户'];

const BUDGETS = [
  { value: '1-3', label: '1 – 3 万' },
  { value: '3-5', label: '3 – 5 万' },
  { value: '5-10', label: '5 – 10 万' },
  { value: '10+', label: '10 万以上' },
  { value: 'none', label: '暂不填写' },
];

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
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState('A');
  const [version, setVersion] = useState<'standard' | 'presale' | 'private'>('standard');
  const [pageCount, setPageCount] = useState(9);
  const [form] = Form.useForm();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [generating, setGenerating] = useState(false);
  const [editing, setEditing] = useState<{ index: number; heading: string; body: string; narration: string } | null>(null);
  const [savingPage, setSavingPage] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PlanListItem[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [showNarration, setShowNarration] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [renderingFloorplan, setRenderingFloorplan] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

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
    try {
      const created = await api<PlanDetail>('/api/plans', {
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
        }),
      });
      setPlan(created);
      setStep(1);
      message.success(`方案文案已生成（${created.pages.length} 页），可逐页审稿编辑`);
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const savePage = async (): Promise<void> => {
    if (!editing || !plan) return;
    setSavingPage(true);
    try {
      const updated = await api<PlanDetail>(`/api/plans/${plan.id}/pages/${editing.index}`, {
        method: 'PATCH',
        body: JSON.stringify({ heading: editing.heading, body: editing.body, narration: editing.narration }),
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
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
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
            <Form.Item label="预算" name="budget">
              <Select placeholder="请选择预算（可暂不填写）" options={BUDGETS} size="large" allowClear />
            </Form.Item>
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
              onClick={() => setEditing({ index: i, heading: p.heading, body: p.body, narration: p.narration })}
              onKeyDown={(e) => e.key === 'Enter' && setEditing({ index: i, heading: p.heading, body: p.body, narration: p.narration })}
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
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
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
              <Button size="small" icon={<EditOutlined />} onClick={() => setEditing({ index: activePage, heading: active.heading, body: active.body, narration: active.narration })}>
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
              <Button size="large" icon={<FullscreenOutlined />} onClick={() => setPlaying(true)}>
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
          <div>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>页标题</Text>
            <Input value={editing.heading} onChange={(e) => setEditing({ ...editing, heading: e.target.value })} maxLength={200} style={{ marginBottom: 14 }} />
            <Text strong style={{ display: 'block', marginBottom: 6 }}>正文文案</Text>
            <Input.TextArea rows={5} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} maxLength={8000} showCount style={{ marginBottom: 14 }} />
            <Text strong style={{ display: 'block', marginBottom: 6 }}>本页讲解稿（销售当面讲解用，客户阅读模式不显示）</Text>
            <Input.TextArea rows={4} value={editing.narration} onChange={(e) => setEditing({ ...editing, narration: e.target.value })} maxLength={8000} />
          </div>
        ) : null}
      </Modal>

      {/* 全屏播放 */}
      <Modal
        open={playing}
        footer={null}
        onCancel={() => setPlaying(false)}
        width="92vw"
        centered
        styles={{ body: { padding: 8 } }}
        title={`全屏播放 · ${plan?.title ?? ''}`}
      >
        {plan && plan.pages[activePage] ? (
          <div>
            <PlanSlide page={plan.pages[activePage]} index={activePage} plan={slidePlan} t={t} />
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 12 }}>
              <Button icon={<LeftOutlined />} disabled={activePage === 0} onClick={() => setActivePage(activePage - 1)}>上一页</Button>
              <Text style={{ lineHeight: '32px' }}>{activePage + 1} / {plan.pages.length}</Text>
              <Button disabled={activePage >= plan.pages.length - 1} onClick={() => setActivePage(activePage + 1)}>
                下一页 <RightOutlined />
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

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
