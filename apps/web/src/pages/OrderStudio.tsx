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
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Grid,
  Input,
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
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
  categories: string[];
  products: { id: string; name: string; category: string; priceMin: number; priceMax: number; perRoom: string }[];
}

interface PlanBrief {
  id: string;
  title: string;
  pageCount: number;
}

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
      const r = await api<IntakeResult>('/api/orders/intake', { method: 'POST', body: JSON.stringify({ rawInput: intakeText }) });
      setIntake(r);
      form.setFieldsValue({
        customer: r.customer, phone: r.phone, community: r.community, area: r.area,
        layout: r.layout, budget: r.budget, ecosystem: r.ecosystem, needs: r.needs,
      });
      message.success('AI 已解析，请核对补全后保存');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setIntakeLoading(false);
    }
  };

  /** 第一步：创建线索 */
  const createOrder = async (): Promise<void> => {
    let values: Record<string, string>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    try {
      const o = await api<Order>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ ...values, rawInput: intakeText }),
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
      const r = await api<{ advice: string }>(`/api/orders/${current.id}/followup`, { method: 'POST' });
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

      <Row gutter={16}>
        {/* 左：接待列表 */}
        <Col xs={24} lg={7}>
          <Card
            title="接待列表"
            extra={
              <Button type="primary" size="small" icon={<PlusOutlined />} style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={() => setNewOpen(true)}>
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
        </Col>

        {/* 右：接待详情向导 */}
        <Col xs={24} lg={17}>
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
                  { key: '4', label: '预算', children: current.budget || '-' },
                  { key: '5', label: '生态', children: current.ecosystem || '-' },
                  { key: '6', label: '需求', children: current.needs || '-' },
                ]} />
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
              <Card title={<Space><HistoryOutlined />跟进记录</Space>} extra={<Button icon={<RobotOutlined />} loading={adviceLoading} onClick={() => void askAdvice()}>AI 跟进建议</Button>} styles={{ body: { padding: 18 } }}>
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
        </Col>
      </Row>

      {/* 新接待弹窗：AI 解析 + 建档 */}
      <Modal
        title="开始新接待"
        open={newOpen}
        onCancel={() => setNewOpen(false)}
        width={isWide ? 760 : 520}
        okText={intake ? '保存线索' : '直接保存'}
        onOk={() => void createOrder()}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="把客户微信原话、电话纪要等原始描述粘贴进来，AI 自动解析成结构化档案并推荐关注品类（解析扣少量额度）。" />
        <TextArea rows={4} value={intakeText} onChange={(e) => setIntakeText(e.target.value)} placeholder="例：王先生，东湖玖章 128㎡ 四室两厅，预算 3 万左右，想做米家全屋智能，重点客厅灯光+主卧窗帘+全屋 WiFi 覆盖，下月开工…" maxLength={4000} />
        <Space style={{ margin: '10px 0' }}>
          <Button icon={<RobotOutlined />} loading={intakeLoading} onClick={() => void runIntake()} style={{ background: BRAND_GRADIENT, border: 'none', color: '#fff' }}>AI 解析建档</Button>
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
        <Form form={form} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 5 } : undefined} wrapperCol={isWide ? { span: 19 } : undefined}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="customer" label="客户称呼" rules={[{ required: true, message: '必填' }]}><Input placeholder="王先生" /></Form.Item></Col>
            <Col span={12}><Form.Item name="phone" label="电话"><Input placeholder="选填" /></Form.Item></Col>
            <Col span={12}><Form.Item name="community" label="小区"><Input placeholder="东湖玖章" /></Form.Item></Col>
            <Col span={6}><Form.Item name="area" label="面积㎡"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item name="layout" label="户型"><Input placeholder="四室两厅" /></Form.Item></Col>
            <Col span={12}><Form.Item name="budget" label="预算"><Input placeholder="3 万左右" /></Form.Item></Col>
            <Col span={12}><Form.Item name="ecosystem" label="生态偏好"><Input placeholder="米家 / HomeKit / 不限" /></Form.Item></Col>
            <Col span={24}><Form.Item name="needs" label="需求要点"><TextArea rows={2} placeholder="客厅灯光、主卧窗帘、全屋 WiFi…" /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
