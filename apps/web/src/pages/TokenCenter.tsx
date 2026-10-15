import {
  CopyOutlined,
  DownloadOutlined,
  LockOutlined,
  LogoutOutlined,
  PlusOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  Col,
  ColorPicker,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Radio,
  Row,
  Space, Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from '../lib/api';
import { tokenToYuan } from '../lib/money';
import { PageHeader } from '../components/PageHeader';
import { UserAvatar } from '../components/UserAvatar';
import { useAuth, type UserProfile } from '../store/AuthContext';
import { setShowBilling } from '../layouts/MainLayout';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import { BRAND_GRADIENT, INK_BLACK, pageContainerStyle } from '../theme/tokens';

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

/**
 * 套餐标签：取值必须与 prisma/schema.prisma 的 Plan 枚举一致（BASIC / STANDARD / ENTERPRISE）。
 * 之前这里比的是 'lifetime'，而枚举里从来没有这个值（且大小写也不匹配），导致「永久会员」标签恒不显示。
 * 将来真要加 LIFETIME 套餐，在这里补一行即可，不要在前端另造取值。
 */
const PLAN_META: Record<string, { label: string; color: string }> = {
  BASIC: { label: '基础版', color: 'default' },
  STANDARD: { label: '标准版', color: 'blue' },
  ENTERPRISE: { label: '企业版', color: 'purple' },
};

const REASON_META: Record<string, { label: string; color: string }> = {
  GRANT: { label: '注册发放', color: 'blue' },
  CONSUME: { label: '消耗', color: 'red' },
  RECHARGE: { label: '充值', color: 'green' },
  REFUND: { label: '退还', color: 'orange' },
};

interface StorageStat {
  usedBytes: number;
  quotaBytes: number;
  assets: number;
  oldest: string | null;
}

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'auto' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];

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
  const { user, logout, refresh, renewToken } = useAuth();
  const { mode, setMode } = useTheme();
  const [showBilling, setShowBillingState] = useState(() => localStorage.getItem('show_billing') === '1');
  const [renewing, setRenewing] = useState(false);
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>('standard');
  const [pwdForm] = Form.useForm();
  const [pwdLoading, setPwdLoading] = useState(false);
  const [profileForm] = Form.useForm<{ displayName: string; avatarColor: string | { toHexString?: () => string } }>();
  const [profileSaving, setProfileSaving] = useState(false);
  const [backing, setBacking] = useState(false);
  const [storage, setStorage] = useState<StorageStat | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const isAdmin = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage')) ?? false;

  // 管理员进入页面即拉取产物占用（存储治理卡）
  useEffect(() => {
    if (isAdmin) void loadStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

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
      // 后端已自增 tokenVersion，当前 JWT 即刻失效：主动登出，引导用新密码重新登录
      message.success('密码已更新，需使用新密码重新登录');
      pwdForm.resetFields();
      setTimeout(() => logout(), 800);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      message.error(raw === 'INVALID_CREDENTIALS' ? '原密码不正确' : raw);
    } finally {
      setPwdLoading(false);
    }
  };

  const saveProfile = async (): Promise<void> => {
    let values: { displayName: string; avatarColor: string | { toHexString?: () => string } };
    try {
      values = await profileForm.validateFields();
    } catch {
      return;
    }
    setProfileSaving(true);
    try {
      const color = typeof values.avatarColor === 'string' ? values.avatarColor : values.avatarColor?.toHexString?.() ?? '#6D4DF6';
      await api<UserProfile>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: values.displayName.trim(), avatarColor: color }),
      });
      await refresh();
      message.success('个人资料已保存');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileSaving(false);
    }
  };

  const loadStorage = async (): Promise<void> => {
    try {
      setStorage(await api<StorageStat>('/api/admin/storage'));
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const cleanup = (): void => {
    modal.confirm({
      title: '清理 30 天前的产物？',
      content: '删除 30 天前生成且未被方案/点位布局引用的图片与视频（含本地文件），用于释放磁盘空间。此操作不可恢复。',
      okText: '确认清理',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setCleaning(true);
        try {
          const r = await api<{ deleted: number; freedBytes: number }>('/api/admin/storage/cleanup?beforeDays=30', { method: 'POST' });
          message.success(`已清理 ${r.deleted} 项，释放 ${(r.freedBytes / 1048576).toFixed(1)} MB`);
          await loadStorage();
        } catch (err: unknown) {
          message.error(err instanceof Error ? err.message : String(err));
        } finally {
          setCleaning(false);
        }
      },
    });
  };

  const downloadBackup = async (): Promise<void> => {
    setBacking(true);
    try {
      const res = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } });
      if (!res.ok) throw new Error(`备份失败 ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('全库 JSON 已导出（产物文件在 uploads 卷，迁移时一并备份）');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBacking(false);
    }
  };

  const renew = async (): Promise<void> => {
    setRenewing(true);
    const ok = await renewToken();
    setRenewing(false);
    if (ok) message.success('登录令牌已刷新，有效期重新计时');
    else message.error('刷新失败，请重新登录');
  };

  const membership = user?.memberships[0];

  return (
    <div style={pageContainerStyle}>
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
          <UserAvatar user={user} size={56} shape="square" fontSize={24} allowUpload />
          <div>
            <Space size={8}>
              <Text strong style={{ fontSize: 17 }}>{user?.displayName ?? '未命名'}</Text>
              {membership ? <Tag color={PLAN_META[membership.plan]?.color ?? 'default'}>{PLAN_META[membership.plan]?.label ?? membership.plan}</Tag> : null}
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

      {/* 两栏网格：左=资料与偏好，右=额度 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
            <Text strong style={{ fontSize: 15 }}>资料与偏好</Text>
            <Form
              form={profileForm}
              layout="vertical"
              initialValues={{ displayName: user?.displayName ?? '', avatarColor: user?.avatarColor ?? '#6D4DF6' }}
              style={{ marginTop: 12 }}
            >
              <Space align="start" size={16} style={{ width: '100%' }}>
                <Form.Item noStyle shouldUpdate>
                  {() => (
                    <Avatar
                      size={56}
                      style={{
                        borderRadius: 14,
                        background: (() => {
                          const v = profileForm.getFieldValue('avatarColor');
                          return typeof v === 'string' ? v : (v?.toHexString?.() ?? '#6D4DF6');
                        })(),
                        fontSize: 24,
                        fontWeight: 700,
                        flex: 'none',
                      }}
                    >
                      {(profileForm.getFieldValue('displayName') ?? user?.displayName ?? 'U').slice(0, 1)}
                    </Avatar>
                  )}
                </Form.Item>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Form.Item name="displayName" label="昵称" rules={[{ required: true, message: '请输入昵称' }, { max: 32 }]}>
                    <Input placeholder="显示名称" />
                  </Form.Item>
                  <Form.Item name="avatarColor" label="头像颜色">
                    <ColorPicker showText format="hex" disabledAlpha />
                  </Form.Item>
                </div>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>界面主题</Text>
              <Radio.Group
                style={{ display: 'block', margin: '8px 0 12px' }}
                optionType="button"
                buttonStyle="solid"
                value={mode}
                onChange={(e) => setMode(e.target.value as ThemeMode)}
                options={THEME_OPTIONS}
                block
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0 2px' }}>
                <Space direction="vertical" size={0}>
                  <Text style={{ fontSize: 13 }}>顶栏显示额度与会员</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>默认隐藏，开源免费使用下这两项没有实际意义</Text>
                </Space>
                <Switch checked={showBilling} onChange={(v) => { setShowBillingState(v); setShowBilling(v); }} />
              </div>
              <Button type="primary" loading={profileSaving} onClick={() => void saveProfile()} block style={{ marginTop: 8 }}>
                保存资料
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
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
        </Col>

        {/* 第二行：左=邀请，右=备份治理（管理员）/改密占位 */}
        <Col xs={24} lg={12}>
          <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
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
        </Col>
        {isAdmin ? (
          <Col xs={24} lg={12}>
            <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
              <Text strong style={{ fontSize: 15 }}>数据备份与存储治理</Text>
              <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 12 }}>
                <Button icon={<DownloadOutlined />} loading={backing} onClick={() => void downloadBackup()} block>
                  导出全库数据备份（JSON）
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  升级迁移前留底；产物文件位于 uploads 卷（docker volume），迁移时连同数据库卷一起备份即可完整恢复。
                </Text>
                <Space.Compact block>
                  <Button style={{ flex: 1 }} onClick={() => void loadStorage()}>
                    {storage ? `产物占用 ${(storage.usedBytes / 1048576).toFixed(1)} / ${(storage.quotaBytes / 1048576).toFixed(0)} MB` : '查看产物存储占用'}
                  </Button>
                  <Button danger loading={cleaning} disabled={!storage} onClick={() => void cleanup()}>
                    清理 30 天前未引用产物
                  </Button>
                </Space.Compact>
              </Space>
            </Card>
          </Col>
        ) : null}

        {/* 第三行：修改密码 + 退出登录 */}
        <Col xs={24} lg={12}>
          <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
            <Space size={8} style={{ marginBottom: 12 }}>
              <LockOutlined />
              <Text strong style={{ fontSize: 15 }}>修改登录密码</Text>
            </Space>
            <Form form={pwdForm} layout="vertical" onFinish={changePassword} requiredMark={false}>
              <Form.Item name="oldPassword" rules={[{ required: true, message: '请输入原密码' }]}>
                <Input.Password placeholder="原密码" />
              </Form.Item>
              <Form.Item name="newPassword" rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '至少 8 位' }]}>
                <Input.Password placeholder="新密码（至少 8 位）" />
              </Form.Item>
              <Form.Item name="confirm" rules={[{ required: true, message: '请再次输入新密码' }]}>
                <Input.Password placeholder="再次输入新密码" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={pwdLoading} style={{ background: INK_BLACK, border: 'none', borderRadius: 9999 }}>
                保存新密码
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
            <Text strong style={{ fontSize: 15 }}>账号安全</Text>
            <Text type="secondary" style={{ fontSize: 12.5, display: 'block', margin: '10px 0 12px' }}>
              登录令牌有效期 7 天，临期自动续期；也可手动刷新换取新令牌，避免过期丢会话。所有操作数据已持久化到数据库，退出不会丢失。
            </Text>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Button loading={renewing} icon={<SyncOutlined />} onClick={() => void renew()} block>
                刷新登录令牌
              </Button>
              <Button danger icon={<LogoutOutlined />} onClick={logout} block>
                退出登录
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* 账本明细 */}
      <Card title="账本明细" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
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
