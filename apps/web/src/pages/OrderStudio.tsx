import {
  CheckCircleOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Timeline,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { PageHeader } from '../components/PageHeader';
import {
  NEED_OPTIONS, RENO_STAGES, SCENES, SYSTEMS,
  RENO_STAGE_LABEL, sceneLabels, systemSummary,
  type SystemsMap,
} from '../lib/orderIntake';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;
const { TextArea } = Input;

/** 线索状态机（与后端 TRANSITIONS 对齐） */
const STATUS_FLOW: string[] = ['new', 'qualified', 'proposed', 'quoted', 'won'];
/** 状态对应的步骤索引（lost 等不在主流程内的状态归到 0） */
function flowIndexOf(status: string): number {
  const i = STATUS_FLOW.indexOf(status);
  return i === -1 ? 0 : Math.min(i, 4);
}
const STATUS_LABELS: Record<string, string> = {
  new: '了解客户',
  qualified: '需求确认',
  proposed: '方案匹配',
  quoted: '报价',
  won: '成单',
  lost: '失单',
};
const STATUS_COLORS: Record<string, string> = {
  new: 'default',
  qualified: 'blue',
  proposed: 'purple',
  quoted: 'gold',
  won: 'green',
  lost: 'red',
};

interface OrderNote {
  id: string;
  content: string;
  createdAt: string;
}

interface Order {
  id: string;
  customer: string;
  phone: string;
  community: string;
  area: string;
  layout: string;
  needs: string;
  rawInput: string;
  budget: string;
  ecosystem: string;
  // —— 结构化采集（2026-10-13 补齐）——
  renoStage: string;
  moveInDate: string;
  city: string;
  district: string;
  address: string;
  store: string;
  residents: string;
  priority1: string;
  priority2: string;
  priority3: string;
  exclusions: string;
  habits: string;
  nightHabits: string;
  devicePrefs: string;
  scenes: string[];
  systems: SystemsMap;
  budgetMin: number;
  budgetMax: number;
  budgetScope: string;
  status: string;
  planId: string | null;
  lostReason: string;
  createdAt: string;
  updatedAt: string;
  notes?: OrderNote[];
  _count?: { notes: number };
}

interface IntakeResult {
  customer: string;
  phone: string;
  community: string;
  area: string;
  layout: string;
  budget: string;
  ecosystem: string;
  needs: string;
  renoStage: string;
  moveInDate: string;
  city: string;
  district: string;
  address: string;
  store: string;
  residents: string;
  priority1: string;
  priority2: string;
  priority3: string;
  exclusions: string;
  habits: string;
  nightHabits: string;
  devicePrefs: string;
  scenes: string[];
  systems: SystemsMap;
  budgetMin: number;
  budgetMax: number;
  budgetScope: string;
  categories: string[];
  products: { id: string; name: string; category: string; priceMin: number; priceMax: number; perRoom: string }[];
}

interface PlanBrief {
  id: string;
  title: string;
  pageCount: number;
}

/**
 * 幂等键：同一次操作重试（弱网超时、手抖连点）不该重复扣额度。
 * intakeIdRef 为空表示当前没有「进行中」的一次解析；成功后置空，下次是新操作。
 * followupKeys 按线索 id 分开存，避免两条线索互相顶掉对方的键。
 */
let intakeIdRef: string | null = null;
const followupKeys = new Map<string, string>();

const CATEGORY_NAMES: Record<string, string> = {
  gateway: '网关', switch: '开关', sensor: '传感器', light: '照明', curtain: '窗帘',
  security: '安防', appliance: '家电', audio: '影音', hvac: '暖通',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function OrderStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const isWide = screens.lg ?? false;

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<Order | null>(null);
  const [step, setStep] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [intakeText, setIntakeText] = useState('');
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intake, setIntake] = useState<IntakeResult | null>(null);
  const [form] = Form.useForm<Omit<Order, 'id' | 'status' | 'planId' | 'lostReason' | 'createdAt' | 'updatedAt' | 'notes' | '_count' | 'rawInput'> & { rawInput?: string }>();
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [advice, setAdvice] = useState<string | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [plans, setPlans] = useState<PlanBrief[]>([]);
  const [pickedPlan, setPickedPlan] = useState<string | undefined>();

  const reload = useCallback(async (): Promise<void> => {
    setOrders(await api<Order[]>('/api/orders'));
  }, []);

  useEffect(() => {
    reload().catch((e) => message.error((e as Error).message)).finally(() => setLoading(false));
  }, [reload, message]);

  const openOrder = async (id: string): Promise<void> => {
    try {
      const o = await api<Order>(`/api/orders/${id}`);
      setCurrent(o);
      setStep(flowIndexOf(o.status));
      setAdvice(null);
      setPickedPlan(o.planId ?? undefined);
      setIntake(null);
      setIntakeText(o.rawInput ?? '');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 第一步：AI 解析原始描述 */
  const runIntake = async (): Promise<void> => {
    if (intakeText.trim().length < 10) {
      message.warning('请先粘贴至少 10 个字的客户原始描述');
      return;
    }
    setIntakeLoading(true);
    try {
      // 幂等键：重复点「AI 解析」不该重复扣额度
      const r = await api<IntakeResult>('/api/orders/intake', {
        method: 'POST',
        body: JSON.stringify({ rawInput: intakeText, clientRequestId: (intakeIdRef ??= newRequestId()) }),
      });
      intakeIdRef = null;
      setIntake(r);
      // 结构化字段一并回填：AI 解析出的场景/系统三态/预算上下限直接落到表单，
      // 销售在此基础上核对修改，而不是解析完还得手敲一遍。
      form.setFieldsValue({
        customer: r.customer, phone: r.phone, community: r.community, area: r.area,
        layout: r.layout, budget: r.budget, ecosystem: r.ecosystem, needs: r.needs,
        renoStage: r.renoStage, moveInDate: r.moveInDate, city: r.city, district: r.district,
        address: r.address, store: r.store, residents: r.residents,
        priority1: r.priority1, priority2: r.priority2, priority3: r.priority3,
        exclusions: r.exclusions, habits: r.habits, nightHabits: r.nightHabits, devicePrefs: r.devicePrefs,
        scenes: r.scenes, systems: r.systems,
        budgetMin: r.budgetMin || undefined, budgetMax: r.budgetMax || undefined, budgetScope: r.budgetScope,
      });
      message.success('AI 已解析，请核对补全后保存');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setIntakeLoading(false);
    }
  };

  /** 第一步：创建线索 */
  /** 打开「开始新接待」：给系统矩阵预置完整初值（9 类 × maybe/空/空），
      否则用户没碰过的行会是 undefined，提交时被后端 zod 判为缺 area/detail。 */
  const openNew = (): void => {
    form.resetFields();
    const systems: SystemsMap = {};
    for (const s of SYSTEMS) systems[s.value] = { need: 'maybe', area: '', detail: '' };
    form.setFieldsValue({ renoStage: 'undecided', scenes: [], systems });
    setIntake(null);
    setNewOpen(true);
  };

  const createOrder = async (): Promise<void> => {
    let values: Record<string, unknown>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    // InputNumber 清空时给 undefined、初始系统矩阵可能有空行，统一归一化再提交
    const systems: SystemsMap = {};
    const raw = (values.systems ?? {}) as Record<string, { need?: string; area?: string; detail?: string }>;
    for (const s of SYSTEMS) {
      const e = raw[s.value];
      if (!e) continue;
      systems[s.value] = {
        need: (e.need === 'yes' || e.need === 'no' || e.need === 'maybe' ? e.need : 'maybe'),
        area: e.area ?? '',
        detail: e.detail ?? '',
      };
    }
    try {
      const o = await api<Order>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          systems,
          budgetMin: values.budgetMin || 0,
          budgetMax: values.budgetMax || 0,
          rawInput: intakeText,
        }),
      });
      setNewOpen(false);
      form.resetFields();
      setIntake(null);
      setIntakeText('');
      await reload();
      await openOrder(o.id);
      message.success('接待线索已创建');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 推进/回退状态 */
  const moveTo = async (status: string): Promise<void> => {
    if (!current) return;
    try {
      const updated = await api<Order>(`/api/orders/${current.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(status === 'proposed' && pickedPlan ? { planId: pickedPlan } : {}) }),
      });
      setCurrent({ ...current, ...updated });
      await reload();
      message.success(`已推进到「${STATUS_LABELS[status]}」`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const markLost = (): void => {
    if (!current) return;
    let reason = '';
    Modal.confirm({
      title: '标记为失单？',
      content: (
        <TextArea
          placeholder="失单原因（可选：价格、竞品、暂缓装修…）"
          onChange={(e) => { reason = e.target.value; }}
          maxLength={200}
        />
      ),
      okText: '确认失单',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api(`/api/orders/${current.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'lost', lostReason: reason }) });
        await reload();
        setCurrent(null);
        message.success('已标记失单');
      },
    });
  };

  const addNote = async (): Promise<void> => {
    if (!current || !noteText.trim()) return;
    setNoteSaving(true);
    try {
      await api(`/api/orders/${current.id}/notes`, { method: 'POST', body: JSON.stringify({ content: noteText }) });
      setNoteText('');
      const fresh = await api<Order>(`/api/orders/${current.id}`);
      setCurrent(fresh);
      message.success('跟进已记录');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setNoteSaving(false);
    }
  };

  const askAdvice = async (): Promise<void> => {
    if (!current) return;
    setAdviceLoading(true);
    try {
      // 同一条线索的跟进建议：连点两次只算一次
      const r = await api<{ advice: string; deduped?: boolean }>(`/api/orders/${current.id}/followup`, {
        method: 'POST',
        body: JSON.stringify({ clientRequestId: followupKeys.get(current.id) ?? newRequestId() }),
      });
      followupKeys.set(current.id, '');
      setAdvice(r.advice);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAdviceLoading(false);
    }
  };

  const removeOrder = async (id: string): Promise<void> => {
    await api(`/api/orders/${id}`, { method: 'DELETE' });
    if (current?.id === id) setCurrent(null);
    await reload();
    message.success('已删除');
  };

  const loadPlans = useCallback(async (): Promise<void> => {
    try {
      setPlans(await api<PlanBrief[]>('/api/plans'));
    } catch {
      setPlans([]);
    }
  }, []);

  const stepIndex = useMemo(() => (current ? flowIndexOf(current.status) : step), [current, step]);

  const grouped = useMemo(() => {
    const g: Record<string, Order[]> = {};
    for (const o of orders) (g[o.status] ??= []).push(o);
    return g;
  }, [orders]);

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="开始接单"
        description="销售接待工作台：粘贴客户原始描述由 AI 解析建档，按「了解客户 → 需求确认 → 方案匹配 → 报价 → 成单」状态机推进，全程跟进记录与 AI 跟进建议。"
      />

      {/*
        原来用 AntD 栅格 lg={7} / lg={17}：lg 是**断点固定比例**，在 1920px 下左栏直接占
        29%（约 472px），比窄栏宽出一倍，右边又被详情内容挤窄，视觉上就是
        「左边空一块、右边挤一堆」。改为 flex：左侧固定窄栏上限，右侧 flex:1 吃满剩余，
        这样视口从 1280 拉到 2560 时新增的宽度全部给真正需要空间的右侧详情。
      */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {/* 左：接待列表（固定窄栏：客户名+状态+时间一行排得下，再窄会断字） */}
        <div style={{ flex: '0 1 300px', minWidth: 260, maxWidth: 340 }}>
          <Card
            title="接待列表"
            extra={
              <Button type="primary" size="small" icon={<PlusOutlined />} style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={openNew}>
                开始新接待
              </Button>
            }
            styles={{ body: { maxHeight: 560, overflowY: 'auto' } }}
          >
            {loading ? <Spin /> : orders.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无接待线索，点「开始新接待」建档" />
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {STATUS_FLOW.filter((s) => grouped[s]?.length).concat(grouped.lost?.length ? ['lost'] : []).map((s) => (
                  <div key={s}>
                    <Badge status={s === 'lost' ? 'error' : s === 'won' ? 'success' : 'processing'} text={<Text type="secondary" style={{ fontSize: 12 }}>{STATUS_LABELS[s]}（{grouped[s]?.length}）</Text>} />
                    {grouped[s]?.map((o) => (
                      <div
                        key={o.id}
                        onClick={() => void openOrder(o.id)}
                        style={{
                          padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginTop: 4,
                          background: current?.id === o.id ? token.colorPrimaryBg : token.colorFillQuaternary,
                          border: `1px solid ${current?.id === o.id ? token.colorPrimaryBorder : 'transparent'}`,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <Text strong style={{ fontSize: 13 }}>{o.customer}</Text>
                          <Text type="secondary" style={{ fontSize: 11 }}>{fmtTime(o.updatedAt)}</Text>
                        </div>
                        <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {[o.community, o.area && `${o.area}㎡`, o.budget].filter(Boolean).join(' · ') || o.needs.slice(0, 20) || '待补充需求'}
                        </Text>
                      </div>
                    ))}
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </div>

        {/* 右：接待详情向导（吃掉全部剩余宽度） */}
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          {!current ? (
            <Card style={{ minHeight: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Empty description="从左侧选择接待线索，或点「开始新接待」" />
            </Card>
          ) : (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Card styles={{ body: { padding: 18 } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Space>
                    <Title level={5} style={{ margin: 0 }}>{current.customer}</Title>
                    <Tag color={STATUS_COLORS[current.status]}>{STATUS_LABELS[current.status]}</Tag>
                    {current.planId ? <Tag color="purple" icon={<CheckCircleOutlined />}>已挂方案</Tag> : null}
                  </Space>
                  <Popconfirm title="删除该接待线索？" onConfirm={() => void removeOrder(current.id)}>
                    <Button danger type="text" size="small" icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
                <Steps
                  size="small"
                  current={stepIndex}
                  style={{ marginTop: 16 }}
                  items={STATUS_FLOW.map((s) => ({ title: STATUS_LABELS[s] }))}
                />
                {current.status === 'lost' ? <Alert type="error" showIcon style={{ marginTop: 12 }} message={`已失单${current.lostReason ? `：${current.lostReason}` : ''}（可重新激活回「了解客户」）`} /> : null}
              </Card>

              {/* 客户与需求 */}
              <Card title="客户与需求" styles={{ body: { padding: 18 } }}>
                <Descriptions size="small" column={isWide ? 3 : 1} items={[
                  { key: '1', label: '电话', children: current.phone || '-' },
                  { key: '2', label: '小区', children: current.community || '-' },
                  { key: '3', label: '面积/户型', children: `${current.area || '-'} ${current.layout}` },
                  { key: '4', label: '装修阶段', children: RENO_STAGE_LABEL[current.renoStage] ?? '-' },
                  { key: '5', label: '预计入住', children: current.moveInDate || '-' },
                  { key: '6', label: '城市/区县', children: [current.city, current.district].filter(Boolean).join(' ') || '-' },
                  { key: '7', label: '门店', children: current.store || '-' },
                  { key: '8', label: '预算', children: current.budget || '-' },
                  { key: '9', label: '预算区间', children: current.budgetMax ? `¥${current.budgetMin.toLocaleString('zh-CN')} ~ ¥${current.budgetMax.toLocaleString('zh-CN')}` : '-' },
                  { key: '10', label: '预算包含', children: current.budgetScope || '-' },
                  { key: '11', label: '生态', children: current.ecosystem || '-' },
                  { key: '12', label: '常住成员', children: current.residents || '-' },
                  { key: '13', label: '优先需求', children: [current.priority1, current.priority2, current.priority3].filter(Boolean).join(' / ') || '-' },
                  { key: '14', label: '明确不做', children: current.exclusions || '-' },
                  { key: '15', label: '控制习惯', children: current.habits || '-' },
                  { key: '16', label: '睡前夜间', children: current.nightHabits || '-' },
                  { key: '17', label: '已有设备', children: current.devicePrefs || '-' },
                  { key: '18', label: '需求', children: current.needs || '-' },
                ]} />

                {/* 体验场景与系统范围：下游方案与报价的结构化输入，必须让人一眼看到采到了什么 */}
                <Divider style={{ margin: '14px 0 10px' }}>体验场景与系统范围</Divider>
                <div style={{ marginBottom: 10 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>想体验的场景　</Text>
                  {sceneLabels(current.scenes).length ? (
                    <Space wrap size={4}>
                      {sceneLabels(current.scenes).map((s) => <Tag key={s} color="purple">{s}</Tag>)}
                    </Space>
                  ) : <Text type="secondary" style={{ fontSize: 12 }}>未记录</Text>}
                </div>
                {(() => {
                  const sum = systemSummary(current.systems);
                  const rows = SYSTEMS.map((s) => {
                    const e = current.systems?.[s.value];
                    if (!e) return null;
                    const opt = NEED_OPTIONS.find((o) => o.value === e.need);
                    return {
                      key: s.value,
                      label: s.label,
                      children: (
                        <Space size={4} wrap>
                          <Tag color={opt?.color}>{opt?.label ?? e.need}</Tag>
                          {e.area ? <Text style={{ fontSize: 12 }}>{e.area}</Text> : null}
                          {e.detail ? <Text type="secondary" style={{ fontSize: 12 }}>· {e.detail}</Text> : null}
                        </Space>
                      ),
                    };
                  }).filter((x): x is NonNullable<typeof x> => x !== null);
                  if (!rows.length) return <Text type="secondary" style={{ fontSize: 12 }}>未记录系统范围</Text>;
                  return (
                    <>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        需要 {sum.yes.length} 项{sum.maybe.length ? `、待定 ${sum.maybe.length} 项` : ''}
                      </Text>
                      <Descriptions size="small" column={isWide ? 3 : 1} style={{ marginTop: 6 }} items={rows} />
                    </>
                  );
                })()}

                {current.rawInput ? (
                  <>
                    <Divider style={{ margin: '10px 0' }} />
                    <Text type="secondary" style={{ fontSize: 12 }}>原始描述：{current.rawInput}</Text>
                  </>
                ) : null}
              </Card>

              {/* 操作区：推进状态 */}
              <Card title="推进接待" styles={{ body: { padding: 18 } }}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {current.status === 'qualified' ? (
                    <Space.Compact block onFocusCapture={() => void loadPlans()}>
                      <Select
                        placeholder="选择已生成的智能方案挂接（可留空）"
                        allowClear
                        style={{ flex: 1 }}
                        value={pickedPlan}
                        onChange={setPickedPlan}
                        options={plans.map((p) => ({ value: p.id, label: `${p.title} · ${p.pageCount}页` }))}
                        onFocus={() => void loadPlans()}
                      />
                      <Button type="primary" style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={() => void moveTo('proposed')}>进入方案匹配</Button>
                    </Space.Compact>
                  ) : null}
                  <Space wrap>
                    {current.status === 'new' ? <Button type="primary" style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={() => void moveTo('qualified')}>需求已确认</Button> : null}
                    {current.status === 'proposed' ? <Button type="primary" style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={() => void moveTo('quoted')}>已发出报价</Button> : null}
                    {current.status === 'quoted' ? <Button type="primary" style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={() => void moveTo('won')}>成单</Button> : null}
                    {current.status !== 'lost' && current.status !== 'won' ? <Button danger onClick={markLost}>失单</Button> : null}
                    {current.status === 'lost' ? <Button onClick={() => void moveTo('new')}>重新激活</Button> : null}
                    {current.planId ? <Button onClick={() => navigate(`/plan?id=${current.planId}`)}>查看挂接方案</Button> : null}
                  </Space>
                </Space>
              </Card>

              {/* 跟进记录 + AI 建议 */}
              <Card
                title={<Space><HistoryOutlined />跟进记录</Space>}
                extra={(
                  <>
                    {/*
                    <Button icon={<RobotOutlined />} loading={adviceLoading} onClick={() => void askAdvice()}>AI 跟进建议</Button>
                    {/*
                    <Button icon={<RobotOutlined />} loading={adviceLoading} onClick={() => void askAdvice()}>AI 跟进建议</Button>
                    */}
                  </>
                )}
                styles={{ body: { padding: 18 } }}
              >
                {advice ? <Alert type="info" showIcon icon={<RobotOutlined />} message="AI 建议" description={advice} style={{ marginBottom: 14 }} /> : null}
                {current.notes && current.notes.length > 0 ? (
                  <Timeline
                    items={current.notes.map((n) => ({
                      children: (
                        <div>
                          <Text style={{ fontSize: 13 }}>{n.content}</Text>
                          <div><Text type="secondary" style={{ fontSize: 11 }}>{fmtTime(n.createdAt)}</Text></div>
                        </div>
                      ),
                    }))}
                  />
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>暂无跟进记录</Text>
                )}
                <Space.Compact block style={{ marginTop: 8 }}>
                  <Input placeholder="记录一次跟进（电话/到店/微信沟通纪要）" value={noteText} onChange={(e) => setNoteText(e.target.value)} onPressEnter={() => void addNote()} maxLength={2000} />
                  <Button type="primary" loading={noteSaving} onClick={() => void addNote()} style={{ background: BRAND_GRADIENT, border: 'none' }}>记录</Button>
                </Space.Compact>
              </Card>
            </Space>
          )}
        </div>
      </div>

      {/* 新接待弹窗：AI 解析 + 结构化建档
          分区顺序按接待表单：客户与房屋 → 生活需求 → 体验场景 → 系统范围与预算。 */}
      <Modal
        title="开始新接待"
        open={newOpen}
        onCancel={() => setNewOpen(false)}
        width={isWide ? 1000 : '92vw'}
        okText={intake ? '保存线索' : '直接保存'}
        onOk={() => void createOrder()}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="把客户微信原话、电话纪要等原始描述粘贴进来，AI 自动解析成结构化档案（含体验场景、系统范围、预算上下限）并推荐关注品类。" />
        <TextArea rows={3} value={intakeText} onChange={(e) => setIntakeText(e.target.value)} placeholder="例：王先生，东湖玖章 128㎡ 四室两厅，预算 3 万左右，想做米家全屋智能，重点客厅灯光+主卧窗帘+全屋 WiFi 覆盖，下月开工…" maxLength={4000} />
        <Space style={{ margin: '10px 0' }}>
          {/*
          <Button icon={<RobotOutlined />} loading={intakeLoading} onClick={() => void runIntake()} style={{ background: BRAND_GRADIENT, border: 'none', color: '#fff' }}>AI 解析建档</Button>
          {/*
          <Button icon={<RobotOutlined />} loading={intakeLoading} onClick={() => void runIntake()} style={{ background: BRAND_GRADIENT, border: 'none', color: '#fff' }}>AI 解析建档</Button>
          */}
          {intakeLoading ? <Text type="secondary">正在解析…</Text> : null}
        </Space>
        {intake ? (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message={`推荐关注：${intake.categories.map((c) => CATEGORY_NAMES[c] ?? c).join('、') || '未识别'}`}
            description={intake.products.length ? <Space wrap size={4} style={{ marginTop: 4 }}>{intake.products.slice(0, 8).map((p) => <Tag key={p.id}>{p.name} ¥{p.priceMin}-{p.priceMax}</Tag>)}</Space> : null}
          />
        ) : null}
        <Form form={form} layout="vertical">
          {/* —— 客户与房屋 —— */}
          <Divider titlePlacement="start" plain style={{ margin: '4px 0 12px' }}>客户与房屋</Divider>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="customer" label="客户称呼" rules={[{ required: true, message: '必填' }]}><Input placeholder="王先生" /></Form.Item></Col>
            <Col span={8}><Form.Item name="phone" label="电话"><Input placeholder="选填" /></Form.Item></Col>
            <Col span={8}><Form.Item name="community" label="项目 / 小区名称"><Input placeholder="东湖玖章" /></Form.Item></Col>
            <Col span={6}><Form.Item name="area" label="房屋面积"><Input placeholder="128㎡" /></Form.Item></Col>
            <Col span={6}><Form.Item name="layout" label="户型"><Input placeholder="四室两厅" /></Form.Item></Col>
            <Col span={12}>
              <Form.Item name="renoStage" label="装修阶段" initialValue="undecided">
                <Select options={RENO_STAGES.map((s) => ({ value: s.value, label: s.label }))} />
              </Form.Item>
            </Col>
            <Col span={6}><Form.Item name="moveInDate" label="预计入住时间"><Input placeholder="明年春节前" /></Form.Item></Col>
            <Col span={6}><Form.Item name="city" label="城市"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item name="district" label="区县"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="address" label="项目地址"><Input placeholder="选填" /></Form.Item></Col>
            <Col span={6}><Form.Item name="store" label="门店 / 服务商"><Input placeholder="选填" /></Form.Item></Col>
            <Col span={6}><Form.Item name="ecosystem" label="生态偏好"><Input placeholder="米家 / HomeKit / 不限" /></Form.Item></Col>
          </Row>

          {/* —— 生活需求 —— */}
          <Divider titlePlacement="start" plain style={{ margin: '12px 0' }}>生活需求</Divider>
          <Row gutter={12}>
            <Col span={24}><Form.Item name="residents" label="谁会经常住在这里"><Input placeholder="例：夫妻、两个孩子、父母" /></Form.Item></Col>
            <Col span={8}><Form.Item name="priority1" label="优先需求 1"><Input placeholder="例：老人起夜不用摸黑" /></Form.Item></Col>
            <Col span={8}><Form.Item name="priority2" label="优先需求 2"><Input placeholder="例：客厅灯光一键控制" /></Form.Item></Col>
            <Col span={8}><Form.Item name="priority3" label="优先需求 3"><Input placeholder="例：卧室 WiFi 稳定覆盖" /></Form.Item></Col>
            <Col span={24}><Form.Item name="exclusions" label="明确不做的内容"><TextArea rows={2} placeholder="不想装的设备、不希望改变的习惯等" /></Form.Item></Col>
            <Col span={12}><Form.Item name="habits" label="控制习惯"><TextArea rows={2} placeholder="例：保留实体开关，不希望自动关灯" /></Form.Item></Col>
            <Col span={12}><Form.Item name="nightHabits" label="睡前与夜间习惯"><TextArea rows={2} placeholder="例：睡前要开床头灯确认门锁" /></Form.Item></Col>
            <Col span={24}><Form.Item name="needs" label="需求要点"><TextArea rows={2} placeholder="客厅灯光、主卧窗帘、全屋 WiFi…" /></Form.Item></Col>
          </Row>

          {/* —— 客户想体验哪些场景 —— */}
          <Divider titlePlacement="start" plain style={{ margin: '12px 0' }}>客户想体验哪些场景</Divider>
          <Form.Item name="scenes" style={{ marginBottom: 12 }}>
            <Checkbox.Group>
              <Space wrap size={[8, 8]}>
                {SCENES.map((s) => (
                  <Checkbox key={s.value} value={s.value} style={{ marginInlineEnd: 0 }}>{s.label}</Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12 }}>先记录期待，下一步可为每张效果图确认具体模式。</Text>

          {/* —— 系统范围与预算 —— */}
          <Divider titlePlacement="start" plain style={{ margin: '12px 0' }}>系统范围与预算</Divider>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            点击系统名称，记录是否需要、应用区域和具体配置。这是下游「智能方案」与「智能报价」唯一的结构化输入。
          </Text>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {SYSTEMS.map((sys) => (
              <Row key={sys.value} gutter={8} align="middle" wrap={false}>
                <Col span={5}>
                  <Form.Item name={['systems', sys.value, 'need']} noStyle>
                    <Select
                      style={{ width: '100%' }}
                      options={NEED_OPTIONS.map((o) => ({
                        value: o.value,
                        label: <Tag color={o.color} style={{ marginInlineEnd: 0 }}>{o.label}</Tag>,
                      }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={4}><Text strong style={{ fontSize: 13 }}>{sys.label}</Text></Col>
                <Col span={7}>
                  <Form.Item name={['systems', sys.value, 'area']} noStyle>
                    <Input placeholder="应用区域，如 客厅 / 全屋" size="small" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name={['systems', sys.value, 'detail']} noStyle>
                    <Input placeholder="具体配置，如 无主灯 + 灯带 + 双控" size="small" />
                  </Form.Item>
                </Col>
              </Row>
            ))}
          </Space>
          <Row gutter={12} style={{ marginTop: 12 }}>
            <Col span={6}>
              <Form.Item name="budgetMin" label="理想预算起点（元）">
                <InputNumber style={{ width: '100%' }} min={0} step={1000} controls={false} placeholder="如 30000" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                name="budgetMax"
                label="客户预算上限（元）"
                dependencies={['budgetMin']}
                rules={[({ getFieldValue }) => ({
                  validator(_, value) {
                    const min = getFieldValue('budgetMin') as number | undefined;
                    if (!min || !value || value >= min) return Promise.resolve();
                    return Promise.reject(new Error('上限不能小于理想起点'));
                  },
                })]}
              >
                <InputNumber style={{ width: '100%' }} min={0} step={1000} controls={false} placeholder="如 60000" />
              </Form.Item>
            </Col>
            <Col span={6}><Form.Item name="budgetScope" label="预算包含范围"><Input placeholder="含施工 / 仅设备" /></Form.Item></Col>
            <Col span={6}><Form.Item name="budget" label="预算备注"><Input placeholder="3 万左右" /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
