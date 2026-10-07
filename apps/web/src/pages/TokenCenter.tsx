import {
  CopyOutlined,
  LockOutlined,
  LogoutOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { tokenToYuan } from '../lib/money';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../store/AuthContext';
import { BRAND_GRADIENT, INK_BLACK } from '../theme/tokens';

const { Text } = Typography;
const { useToken } = theme;

interface TokenBalance {
  tenantId: string;
  tokenBalance: number;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  meta: unknown;
  createdAt: string;
}

const REASON_META: Record<string, { label: string; color: string }> = {
  GRANT: { label: '注册发放', color: 'blue' },
  CONSUME: { label: '消耗', color: 'red' },
  RECHARGE: { label: '充值', color: 'green' },
  REFUND: { label: '退还', color: 'orange' },
};

const PRICE_CHIPS = [
  '生图 / 生视频 / 生方案 / 文案',
  '按实际用量扣减额度',
  '额度单价由部署者按自有模型成本配置',
];

interface PlanDef {
  key: string;
  name: string;
  price: string;
  tokens: string;
  perks: string[];
  highlight?: boolean;
}

const PLANS: PlanDef[] = [
  { key: 'basic', name: '入门包', price: '按部署者定价', tokens: '80,000 token', perks: ['适合个人体验', '基础功能全覆盖', '社区支持'] },
  { key: 'standard', name: '标准包', price: '按部署者定价', tokens: '1,600,000 token', perks: ['适合门店日常', '11 套方案风格库', '点位/报价工具'], highlight: true },
  { key: 'enterprise', name: '团队包', price: '按部署者定价', tokens: '30,000,000 token', perks: ['适合多账号协作', '知识库与素材库', '优先支持'] },
];

/** 邀请码：用户 id 派生稳定 6 位码（返点结算 0.2.0 接入后端） */
function inviteCode(userId: string): string {
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

export function TokenCenter(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const { token } = useToken();
  const { user, logout } = useAuth();
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>('standard');
  const [pwdForm] = Form.useForm();
  const [pwdLoading, setPwdLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      api<TokenBalance>('/api/tenants/current/tokens'),
      api<LedgerEntry[]>('/api/tenants/current/tokens/ledger'),
    ])
      .then(([balanceResult, ledgerResult]) => {
        setBalance(balanceResult);
        setLedger(ledgerResult);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const consumed = Math.abs(ledger.filter((e) => e.delta < 0).reduce((sum, e) => sum + e.delta, 0));
  const granted = ledger.filter((e) => e.delta > 0).reduce((sum, e) => sum + e.delta, 0);
  const total = balance ? balance.tokenBalance + consumed : 0;
  const usedPct = total > 0 ? Math.min(100, Math.round((consumed / total) * 100)) : 0;
  const code = user ? inviteCode(user.id) : '------';

  const confirmRecharge = (): void => {
    modal.info({
      title: '支付通道即将开放',
      content: '在线充值与发票能力将在 S3 版本接入，当前套餐仅作展示。确认后可联系平台管理员人工开通。',
      okText: '我知道了',
    });
  };

  const changePassword = async (values: { oldPassword: string; newPassword: string; confirm: string }): Promise<void> => {
    if (values.newPassword !== values.confirm) {
      message.error('两次输入的新密码不一致');
      return;
    }
    setPwdLoading(true);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: values.oldPassword, newPassword: values.newPassword }),
      });
      message.success('密码已更新，下次登录请使用新密码');
      pwdForm.resetFields();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      message.error(raw === 'INVALID_CREDENTIALS' ? '原密码不正确' : raw);
    } finally {
      setPwdLoading(false);
    }
  };

  const membership = user?.memberships[0];

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', paddingBottom: 24 }}>
      <PageHeader
        title="个人中心"
        description="额度以统一 token 记账、按部署配置展示；注册赠送额度与充值额度合并管理"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setRechargeOpen(true)}
            style={{ background: BRAND_GRADIENT, border: 'none' }}
          >
            充值额度
          </Button>
        }
      />

      {error ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 16 }} /> : null}

      {/* 账号卡 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 20 } }}>
        <Space size={16} align="center" wrap>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: BRAND_GRADIENT,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
              fontWeight: 700,
            }}
          >
            {(user?.displayName ?? 'U').slice(0, 1)}
          </div>
          <div>
            <Space size={8}>
              <Text strong style={{ fontSize: 17 }}>{user?.displayName ?? '未命名'}</Text>
              {membership?.plan === 'lifetime' ? <Tag color="gold">永久会员</Tag> : membership ? <Tag color="purple">会员</Tag> : null}
            </Space>
            <div>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {user?.phone ? `${user.phone.slice(0, 3)}****${user.phone.slice(7)}` : ''}
                {membership ? ` · 公司 ${membership.tenantName}` : ''}
              </Text>
            </div>
          </div>
        </Space>
      </Card>

      {/* 额度卡 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 20 } }}>
        <Text strong style={{ fontSize: 15 }}>我的额度</Text>
        <Row gutter={[16, 16]} style={{ marginTop: 14 }}>
          <Col xs={24} md={10}>
            <div style={{ fontSize: 34, fontWeight: 700, color: token.colorPrimary, lineHeight: 1.2 }}>
              {balance ? tokenToYuan(balance.tokenBalance) : '--'}
            </div>
            <Text type="secondary" style={{ fontSize: 13 }}>额度剩余</Text>
          </Col>
          <Col xs={12} md={7}>
            <Text type="secondary" style={{ fontSize: 12 }}>总额度</Text>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{tokenToYuan(total)}</div>
          </Col>
          <Col xs={12} md={7}>
            <Text type="secondary" style={{ fontSize: 12 }}>已使用</Text>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{tokenToYuan(consumed)}</div>
          </Col>
        </Row>
        <Progress percent={usedPct} showInfo={false} strokeColor={token.colorPrimary} style={{ marginTop: 12 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {PRICE_CHIPS.map((p) => (
            <span
              key={p}
              style={{
                fontSize: 12,
                padding: '4px 12px',
                borderRadius: 9999,
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextSecondary,
              }}
            >
              {p}
            </span>
          ))}
        </div>
      </Card>

      {/* 邀请卡 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 20 } }}>
        <Text strong style={{ fontSize: 15 }}>邀请好友 · 首充双方各得 10% 额度</Text>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 12,
            padding: '10px 14px',
            borderRadius: 10,
            background: token.colorPrimaryBg,
          }}
        >
          <Text style={{ fontSize: 14 }}>
            邀请码：<Text strong style={{ color: token.colorPrimary, fontSize: 16, letterSpacing: 1 }}>{code}</Text>
          </Text>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              void navigator.clipboard?.writeText(`${window.location.origin}/register?invite=${code}`).catch(() => undefined);
              message.success('邀请链接已复制');
            }}
          >
            复制邀请链接
          </Button>
        </div>
        <Text type="secondary" style={{ fontSize: 12.5, display: 'block', marginTop: 10 }}>
          把专属链接发给朋友，TA 注册后首次充值时，你和 TA 各得充值额 10% 的额度奖励。返点结算将在 0.2.0 上线。
        </Text>
      </Card>

      {/* 修改密码 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 20 } }}>
        <Space size={8} style={{ marginBottom: 12 }}>
          <LockOutlined />
          <Text strong style={{ fontSize: 15 }}>修改登录密码</Text>
        </Space>
        <Form form={pwdForm} layout="vertical" onFinish={changePassword} style={{ maxWidth: 420 }} requiredMark={false}>
          <Form.Item name="oldPassword" rules={[{ required: true, message: '请输入原密码' }]}>
            <Input.Password placeholder="原密码" size="large" />
          </Form.Item>
          <Form.Item name="newPassword" rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '至少 8 位' }]}>
            <Input.Password placeholder="新密码（至少 8 位）" size="large" />
          </Form.Item>
          <Form.Item name="confirm" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password placeholder="再次输入新密码" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={pwdLoading} style={{ background: INK_BLACK, border: 'none', borderRadius: 9999 }}>
            保存新密码
          </Button>
        </Form>
      </Card>

      {/* 退出 */}
      <Card
        styles={{ body: { padding: '14px 20px', textAlign: 'center' } }}
        style={{ marginBottom: 16 }}
      >
        <Button type="text" danger icon={<LogoutOutlined />} onClick={logout}>退出登录</Button>
      </Card>

      {/* 账本明细 */}
      <Card title="账本明细" styles={{ body: { padding: 0 } }}>
        <Table<LedgerEntry>
          rowKey="id"
          dataSource={ledger}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账本记录，token 变动后将在此展示" />,
          }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 180, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
            {
              title: '类型',
              dataIndex: 'reason',
              width: 120,
              render: (v: string) => {
                const m = REASON_META[v];
                return <Tag color={m?.color ?? 'default'}>{m?.label ?? v}</Tag>;
              },
            },
            {
              title: '变动',
              dataIndex: 'delta',
              width: 140,
              render: (v: number) => (
                <Text strong style={{ color: v < 0 ? token.colorError : token.colorSuccess }}>
                  {v > 0 ? `+${v.toLocaleString('zh-CN')}` : v.toLocaleString('zh-CN')}
                </Text>
              ),
            },
            {
              title: '备注',
              dataIndex: 'meta',
              render: (v: unknown) => {
                if (!v) return <Text type="secondary">-</Text>;
                const note = (v as { note?: string; source?: string }).note ?? (v as { source?: string }).source;
                return note ?? JSON.stringify(v);
              },
            },
          ]}
        />
      </Card>

      <Modal
        title="充值额度"
        open={rechargeOpen}
        width={760}
        onCancel={() => setRechargeOpen(false)}
        onOk={confirmRecharge}
        okText="立即充值"
        cancelText="稍后再说"
        destroyOnClose
      >
        <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
          {PLANS.map((plan) => {
            const selected = selectedPlan === plan.key;
            return (
              <Col xs={24} sm={8} key={plan.key}>
                <Card
                  hoverable
                  size="small"
                  onClick={() => setSelectedPlan(plan.key)}
                  style={{
                    borderColor: selected ? token.colorPrimary : token.colorBorderSecondary,
                    borderWidth: selected ? 2 : 1,
                    background: plan.highlight && !selected ? token.colorPrimaryBg : token.colorBgContainer,
                  }}
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space>
                      <Text strong>{plan.name}</Text>
                      {plan.highlight ? <Tag color="purple">推荐</Tag> : null}
                    </Space>
                    <Text style={{ fontSize: 22, fontWeight: 600, color: token.colorPrimary }}>{plan.price}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{plan.tokens}</Text>
                    {plan.perks.map((perk) => (
                      <Text key={perk} type="secondary" style={{ fontSize: 12 }}>· {perk}</Text>
                    ))}
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message="额度按统一单位计量，不同 AI 能力按单价扣减；充值后即时到账，支持开票（S3）。"
        />
      </Modal>
    </div>
  );
}
