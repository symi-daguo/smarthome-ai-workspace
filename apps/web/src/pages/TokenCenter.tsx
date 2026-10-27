import {
  DownloadOutlined,
  LockOutlined,
  LogoutOutlined,
  SyncOutlined,
  UploadOutlined,
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
  InputNumber,
  Modal,
  Progress,
  Radio,
  Row,
  Space, Switch,
  Table,
  Tag,
  Upload,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from '../lib/api';
import { loadBranding, useBranding } from '../lib/branding';
import { downloadBlob } from '../lib/download';
import { tokenToYuan } from '../lib/money';
import { PageHeader } from '../components/PageHeader';
import { UserAvatar } from '../components/UserAvatar';
import { useAuth, type UserProfile } from '../store/AuthContext';
import { setShowBilling } from '../layouts/MainLayout';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import { getHiddenSidebarKeys, resetSidebarVisibility, setSidebarVisible } from '../lib/sidebarVisibility';
import { SIDEBAR_ENTRIES, SIDEBAR_GROUPS } from '../data/sidebarEntries';
import { INK_BLACK, pageContainerStyle } from '../theme/tokens';

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
 * 之前这里比的是 'lifetime'，而枚举里从来没有这个值（且大小写也不匹配），导致旧套餐标签恒不显示。
 * 将来真要加 LIFETIME 套餐，在这里补一行即可，不要在前端另造取值。
 */
const PLAN_META: Record<string, { label: string; color: string }> = {
  BASIC: { label: '基础档', color: 'default' },
  STANDARD: { label: '标准档', color: 'blue' },
  ENTERPRISE: { label: '团队档', color: 'purple' },
};

// 账本只有两种真实来源：注册/管理员发放（GRANT）与调用消耗（CONSUME）。
// RECHARGE / REFUND 是建表时的枚举占位，后端从未写入过（发放统一走 GRANT），
// 且「充值」一词与本项目免费商用、全员最高权限的定位冲突，故不再在前端映射。
const REASON_META: Record<string, { label: string; color: string }> = {
  GRANT: { label: '额度发放', color: 'blue' },
  CONSUME: { label: '消耗', color: 'red' },
};

interface StorageStat {
  usedBytes: number;
  quotaBytes: number;
  assets: number;
  oldest: string | null;
  /** 本租户已用产物字节：与上传闸门同源；旧后端没有这个字段时回退 usedBytes */
  tenantUsedBytes?: number;
}

/**
 * 桌面端设置（仅桌面单机版存在）。
 *
 * **令牌绝不在响应里出现明文**：后端只给「是否已配置」这个布尔值，
 * 与模型配置中心对 API Key 的处理一致。所以令牌输入框永远空着，
 * 留空 = 不改动（用户没法区分「没改」和「想清除」，清除要走显式按钮）。
 */
interface DesktopConfigView {
  brandName: string;
  brandLogoUrl: string;
  narrationTtsUrl: string;
  narrationTtsTokenConfigured: boolean;
  desktop: boolean;
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

export function TokenCenter(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const { token } = useToken();
  const { user, logout, refresh, renewToken } = useAuth();
  const { mode, setMode } = useTheme();
  const [showBilling, setShowBillingState] = useState(() => localStorage.getItem('show_billing') === '1');
  /** 侧栏里被关掉的入口 key 集合（空集合 = 全部显示） */
  const [hiddenSidebarKeys, setHiddenSidebarKeys] = useState<Set<string>>(() => getHiddenSidebarKeys());
  const [renewing, setRenewing] = useState(false);
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pwdForm] = Form.useForm();
  const [pwdLoading, setPwdLoading] = useState(false);
  /** 修改登录手机号（1.0.4）：手机号是登录账号本身，部署预置的是公开示例值，必须能换成自己的 */
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [phoneForm] = Form.useForm<{ phone: string }>();
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [profileForm] = Form.useForm<{ displayName: string; avatarColor: string | { toHexString?: () => string } }>();
  const [profileSaving, setProfileSaving] = useState(false);
  const [backing, setBacking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [storage, setStorage] = useState<StorageStat | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const isAdmin = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage')) ?? false;
  /** 是不是租户/平台管理员（管理员账号本身要能改手机号，也才谈得上「换人管」） */
  const isTenantAdmin = user?.memberships.some((m) => m.roleKey === 'super_admin' || m.roleKey === 'tenant_admin') ?? false;
  /** 部署级品牌（含 desktop 标记）：桌面端才显示「桌面端设置」入口 */
  const branding = useBranding();
  /** 桌面端设置的当前值（令牌只有「是否已配置」） */
  const [desktopCfg, setDesktopCfg] = useState<DesktopConfigView | null>(null);
  const [desktopSaving, setDesktopSaving] = useState(false);
  /**
   * 桌面端设置的表单值。
   *
   * 为什么用普通 state 而不是 antd 的 Form：这一张卡里有一个「令牌」输入框，
   * 它要和旁边的「清除令牌」按钮并排，用 Form 的话值要绕一层 Form.Item 注入，
   * 反而不如直接持有状态清楚。四个字段都是纯文本，直接受控最省事。
   */
  const [desktopForm, setDesktopForm] = useState({
    brandName: '',
    brandLogoUrl: '',
    narrationTtsUrl: '',
    narrationTtsToken: '',
  });

  // 管理员进入页面即拉取产物占用（存储治理卡）
  useEffect(() => {
    if (isAdmin) void loadStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  /**
   * 拉桌面端设置。
   *
   * 只在**桌面单机版 + 管理员**时拉：公开部署没有这个端点（后端返回 404），
   * 去拉一次只是白报一个错。
   */
  useEffect(() => {
    if (!branding.desktop || !isAdmin) return;
    void (async () => {
      try {
        const cfg = await api<DesktopConfigView>('/api/desktop/config');
        setDesktopCfg(cfg);
        setDesktopForm({
          brandName: cfg.brandName,
          brandLogoUrl: cfg.brandLogoUrl,
          narrationTtsUrl: cfg.narrationTtsUrl,
          // 令牌永不留明文在表单里：后端也不回传
          narrationTtsToken: '',
        });
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branding.desktop, isAdmin]);

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

  const changePassword = async (values: { oldPassword: string; newPassword: string; confirm: string }): Promise<void> => {
    if (values.newPassword !== values.confirm) {
      message.error('两次输入的新密码对不上');
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

  /**
   * 修改登录手机号（1.0.4）。
   *
   * 手机号是**登录账号本身**：部署时预置的管理员手机号写在公开文档里，
   * 任何拿到部署地址的人都能用它登录，所以必须有一个地方能换成自己的。
   *
   * 不要求输入原密码 —— 改手机号的场景正是「这号本来就不是我的」，
   * 要求旧密码等于把路堵死。安全边界是「已登录 + 本人操作」，
   * 改完服务端自增 tokenVersion，所有旧会话立即失效。
   */
  const changePhone = async (values: { phone: string }): Promise<void> => {
    setPhoneLoading(true);
    try {
      const res = await api<{ ok: true; changed: boolean }>('/api/auth/change-phone', {
        method: 'POST',
        body: JSON.stringify({ phone: values.phone }),
      });
      setPhoneModalOpen(false);
      phoneForm.resetFields();
      // 后端只在号码**真的改了**时才自增令牌版本。
      // 填回自己当前的号码是幂等操作（什么也没改、会话也没失效）——
      // 这时要是也让用户重新登录，就成了「只是想确认一下号码却被踢下线」。
      if (!res?.changed) {
        message.info('手机号没有变化，未做修改');
        return;
      }
      // 令牌已失效：主动登出，引导用新手机号重新登录
      message.success('手机号已更新，请用新手机号重新登录');
      await refresh().catch(() => undefined);
      setTimeout(() => logout(), 800);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      message.error(
        raw === 'PHONE_EXISTS' ? '这个手机号已经被别的账号占用了'
          : raw === 'SERVICE_ACCOUNT_PHONE_IMMUTABLE' ? '机器账号不能改手机号'
            : raw,
      );
    } finally {
      setPhoneLoading(false);
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
      // 走共用的 downloadBlob：立即 revoke 会让下载还没开始就失效，点了没反应
      // 文件名用**本地日期**：`toISOString()` 取的是 UTC 日期，东八区每天 00:00~07:59
      // 会把今天的备份写成昨天。`toLocaleDateString('sv')` 就是 YYYY-MM-DD。
      downloadBlob(blob, `backup-${new Date().toLocaleDateString('sv')}.json`);
      message.success('本租户数据 JSON 已导出（产物文件在 uploads 卷，迁移时一并备份）');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBacking(false);
    }
  };

  /**
   * 从备份 JSON 恢复。破坏性操作，所以：
   * - 先让用户选模式（merge 不删现有数据 / replace 真回档）
   * - 再弹一次带确认串的框，手滑点不进来
   */
  const restoreBackup = (file: File): void => {
    void (async () => {
      let payload: { tables?: Record<string, unknown>; mode?: 'merge' | 'replace' };
      try {
        payload = JSON.parse(await file.text());
      } catch {
        message.error('文件不是合法 JSON，请选择本平台导出的备份文件');
        return;
      }
      if (!payload?.tables || Object.keys(payload.tables).length === 0) {
        message.error('备份文件里没有任何表数据');
        return;
      }
      modal.confirm({
        title: '确认恢复数据？',
        content: (
          <div style={{ lineHeight: 1.9 }}>
            <div>将按「{restoreMode === 'replace' ? '覆盖' : '合并'}」模式写入
              <Text strong>{Object.keys(payload.tables).length}</Text> 张表。</div>
            {restoreMode === 'replace'
              ? <Text type="danger">覆盖模式会先清空本租户在目标表里的行再写入，可能覆盖当前数据。</Text>
              : <Text type="secondary">合并模式按主键更新，不会删除本库里多出来的数据。</Text>}
          </div>
        ),
        okText: '确认恢复',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          setRestoring(true);
          try {
            const res = await fetch('/api/admin/backup/restore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStore.get() ?? ''}` },
              body: JSON.stringify({ ...payload, mode: restoreMode, confirmToken: 'RESTORE' }),
            });
            if (!res.ok) throw new Error(`恢复失败 ${res.status}`);
            const out = (await res.json()) as { restored: Record<string, number> };
            const rows = Object.values(out.restored).reduce((a, b) => a + b, 0);
            message.success(`恢复完成：写入 ${rows} 行（${Object.keys(out.restored).length} 张表）`);
          } catch (e) {
            message.error(e instanceof Error ? e.message : '恢复失败');
          } finally {
            setRestoring(false);
          }
        },
      });
    })();
  };

  const renew = async (): Promise<void> => {
    setRenewing(true);
    const ok = await renewToken();
    setRenewing(false);
    if (ok) message.success('登录令牌已刷新，有效期重新计时');
    else message.error('刷新失败，请重新登录');
  };

  const membership = user?.memberships[0];

  // —— 报价设置：安装调试费率 ——
  // 报价清单在服务端按当前租户的费率算，PPTX / 讲稿 / 分享页三处同源。
  // 这里改完立即生效，不需要重新生成方案。
  const [installRate, setInstallRate] = useState<number | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ installRate?: number }>('/api/tenants/current')
      .then((t) => {
        if (alive) setInstallRate(typeof t?.installRate === 'number' ? t.installRate : 20);
      })
      .catch(() => {
        /* 拉不到就保持空，保存时再报错 */
      });
    return () => {
      alive = false;
    };
  }, []);
  const saveInstallRate = async (): Promise<void> => {
    if (installRate === null) return;
    setSavingRate(true);
    try {
      await api('/api/tenants/current', { method: 'PATCH', body: JSON.stringify({ installRate }) });
      message.success(`安装调试费率已设为 ${installRate}%`);
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    } finally {
      setSavingRate(false);
    }
  };

  // —— 桌面端设置（仅桌面单机版可见）——

  /**
   * 保存桌面端设置。
   *
   * **两类设置的生效时机不一样，必须说清楚**：
   * - 品牌名 / 图标：后端每次请求现读配置文件，**保存后立即生效**（重新拉一次品牌即可）；
   * - 语音合成服务：它是桌面端主进程**启动时注入**给 API 子进程的环境变量，
   *   所以改完**必须重启桌面应用**才生效 —— 这里明确告诉用户，不假装已经生效。
   */
  const saveDesktopConfig = async (): Promise<void> => {
    setDesktopSaving(true);
    try {
      const saved = await api<DesktopConfigView>('/api/desktop/config', {
        method: 'PUT',
        body: JSON.stringify({
          brandName: desktopForm.brandName,
          brandLogoUrl: desktopForm.brandLogoUrl,
          narrationTtsUrl: desktopForm.narrationTtsUrl,
          // 令牌留空 = 不改动（后端语义与模型配置中心的 apiKey 一致）
          narrationTtsToken: desktopForm.narrationTtsToken,
        }),
      });
      setDesktopCfg(saved);
      // 令牌输入框立刻清空：明文不回显，也不该留在表单里
      setDesktopForm((prev) => ({ ...prev, narrationTtsToken: '' }));
      // 品牌立即生效：重新拉一次公开品牌端点，标题/侧栏/登录页一起更新
      await loadBranding();
      message.success('桌面端设置已保存。品牌名与图标立即生效；语音合成服务需重启桌面应用后才生效');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDesktopSaving(false);
    }
  };

  /**
   * 清除已保存的令牌。
   *
   * 为什么要有这个显式动作：令牌不回显，输入框留空只能表示「不改动」，
   * 用户没法表达「我要清掉」。这里发一个显式哨兵值给后端执行清除。
   */
  const clearDesktopToken = async (): Promise<void> => {
    setDesktopSaving(true);
    try {
      const saved = await api<DesktopConfigView>('/api/desktop/config', {
        method: 'PUT',
        body: JSON.stringify({ narrationTtsToken: '__CLEAR__' }),
      });
      setDesktopCfg(saved);
      setDesktopForm((prev) => ({ ...prev, narrationTtsToken: '' }));
      message.success('已清除语音合成服务令牌，重启桌面应用后生效');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDesktopSaving(false);
    }
  };

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="个人中心"
        description="账号资料、团队权限、备份与存储治理，都在这里"
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
              <Space size={8} wrap>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {user?.phone ? `${user.phone.slice(0, 3)}****${user.phone.slice(7)}` : ''}
                  {membership ? ` · 公司 ${membership.tenantName}` : ''}
                </Text>
                <Button size="small" type="link" onClick={() => setPhoneModalOpen(true)}>
                  修改手机号
                </Button>
              </Space>
            </div>
            {isTenantAdmin && (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                要把管理员换给别人：去「团队与接入」把对方设成管理员，再把自己降级（最后一个管理员不能降级，会被拦住）。
              </Text>
            )}
          </div>
        </Space>
      </Card>

      {/* 报价设置：安装调试费率（影响交付物里的报价清单） */}
      <Card
        title="报价设置"
        style={{ marginBottom: 16 }}
        styles={{ body: { padding: 20 } }}
        extra={
          <Button
            type="primary"
            size="small"
            disabled={installRate === null || savingRate}
            onClick={() => void saveInstallRate()}
          >
            {savingRate ? '保存中…' : '保存费率'}
          </Button>
        }
      >
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Space align="center" wrap>
            <Text style={{ fontSize: 13 }}>安装调试费率</Text>
            <InputNumber
              min={0}
              max={100}
              step={1}
              value={installRate ?? undefined}
              onChange={(v) => setInstallRate(typeof v === 'number' ? v : null)}
              addonAfter="%"
              style={{ width: 120 }}
              placeholder="默认 20"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              按设备参考零售价的百分比计取（行业经验值 15%~25%）
            </Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            报价清单分两项：<Text strong>设备价</Text>（逐项可核对的硬件清单）+
            <Text strong>安装调试费</Text>（设备价 × 本费率）= 整包合计。
            辅材与特殊施工费用按现场实际情况另计。
          </Text>
        </Space>
      </Card>

      {/*
        桌面端设置：只在**桌面单机版**出现（公开部署里完全看不到这张卡）。
        桌面端用户原先得手改 desktop-config.json（改错一个逗号就起不来），
        这里把它变成四个输入框。
      */}
      {branding.desktop && isAdmin ? (
        <Card
          title="桌面端设置"
          style={{ marginBottom: 16 }}
          styles={{ body: { padding: 20 } }}
          extra={
            <Button
              type="primary"
              size="small"
              loading={desktopSaving}
              onClick={() => void saveDesktopConfig()}
            >
              {desktopSaving ? '保存中…' : '保存设置'}
            </Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 12.5, display: 'block', marginBottom: 14 }}>
            桌面单机版的部署配置。<Text strong>品牌名与图标保存后立即生效</Text>；
            语音合成（讲解音频）服务是应用启动时注入的，
            <Text strong>改完需要重启桌面应用</Text>才会生效。
          </Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
            <div>
              <Text style={{ fontSize: 13 }}>品牌名（产品名）</Text>
              <Input
                value={desktopForm.brandName}
                onChange={(e) => setDesktopForm((prev) => ({ ...prev, brandName: e.target.value }))}
                placeholder="留空 = 使用默认名称「智能家居 AI 工作台」"
                style={{ marginTop: 4 }}
              />
            </div>
            <div>
              <Text style={{ fontSize: 13 }}>品牌图标地址</Text>
              <Input
                value={desktopForm.brandLogoUrl}
                onChange={(e) => setDesktopForm((prev) => ({ ...prev, brandLogoUrl: e.target.value }))}
                placeholder="站内路径（如 /images/logo.png）或完整 URL；留空 = 沿用界面自带标识"
                style={{ marginTop: 4 }}
              />
            </div>
            <div>
              <Text style={{ fontSize: 13 }}>语音合成服务地址</Text>
              <Input
                value={desktopForm.narrationTtsUrl}
                onChange={(e) => setDesktopForm((prev) => ({ ...prev, narrationTtsUrl: e.target.value }))}
                placeholder="留空 = 本部署不提供语音（方案照常产出，只是不带讲解音频）"
                style={{ marginTop: 4 }}
              />
            </div>
            <div>
              <Text style={{ fontSize: 13 }}>语音合成服务令牌</Text>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Input.Password
                  value={desktopForm.narrationTtsToken}
                  onChange={(e) => setDesktopForm((prev) => ({ ...prev, narrationTtsToken: e.target.value }))}
                  placeholder={
                    desktopCfg?.narrationTtsTokenConfigured
                      ? '已配置（不回显明文）；留空 = 不改动'
                      : '未配置；填入即保存'
                  }
                  autoComplete="new-password"
                  style={{ flex: 1 }}
                />
                {desktopCfg?.narrationTtsTokenConfigured ? (
                  <Button disabled={desktopSaving} onClick={() => void clearDesktopToken()}>
                    清除令牌
                  </Button>
                ) : null}
              </div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                令牌只写不回显：留空表示不改动；要点「清除令牌」才会真的删掉已保存的令牌。
              </Text>
            </div>
          </div>
        </Card>
      ) : null}

      {/*
        侧栏功能显示设置。
        诉求是「所有功能先全部恢复默认可见，再由每个客户自己决定显示哪些侧栏入口」。
        所以这里只控制**显示**，不控制功能本身 —— 关掉的入口数据仍在，随时能再打开。
        配置存在本机浏览器（localStorage）：侧栏是纯界面偏好，
        门店大屏与笔记本想显示的东西本来就可能不同，不该绑到账号或租户数据上。
      */}
      <Card
        title="侧栏功能显示"
        style={{ marginBottom: 16 }}
        styles={{ body: { padding: 20 } }}
        extra={
          <Button size="small" onClick={() => { resetSidebarVisibility(); setHiddenSidebarKeys(getHiddenSidebarKeys()); message.success('已恢复默认（全部显示）'); }}>
            恢复默认
          </Button>
        }
      >
        <Text type="secondary" style={{ fontSize: 12.5, display: 'block', marginBottom: 14 }}>
          默认全部显示。关掉用不上的入口，侧栏会立刻变清爽；功能本身没有被删除，随时可以再打开。
        </Text>
        {SIDEBAR_GROUPS.map((group) => {
          const items = SIDEBAR_ENTRIES.filter((e) => e.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} style={{ marginBottom: 14 }}>
              <Text strong style={{ fontSize: 13 }}>{group}</Text>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((e) => {
                  const on = !hiddenSidebarKeys.has(e.key);
                  return (
                    <div
                      key={e.key}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <Text style={{ fontSize: 13 }}>{e.label}</Text>
                        <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{e.desc}</Text>
                      </div>
                      <Switch
                        checked={on}
                        onChange={(v) => {
                          setSidebarVisible(e.key, v);
                          setHiddenSidebarKeys(getHiddenSidebarKeys());
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
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
                  <Text style={{ fontSize: 13 }}>界面显示额度与开源说明</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>默认隐藏。关掉后顶栏额度胶囊、侧栏底部的「额度」入口与顶栏「开源说明」一并隐藏</Text>
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
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12, fontSize: 12.5 }}
              message="这是你自己部署的实例，额度由你设定，不设付费墙"
              description="本项目开源免费：任何功能都不会因为额度不足被锁。额度只是让部署者能看清成本、避免误用；计费单价与初始额度都可用 BILLING_* 环境变量调整，额度用完也只是暂停 AI 调用，资料、方案、报价、团队等功能不受影响。"
            />
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


        {/* 第二行：备份治理（管理员）+ 改密 + 账号安全；邀请返点已随「免费商用、全员最高权限」定位移除 */}
        {isAdmin ? (
          <Col xs={24} lg={12}>
            <Card style={{ height: '100%' }} styles={{ body: { padding: 20 } }}>
              <Text strong style={{ fontSize: 15 }}>数据备份与存储治理</Text>
              <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 12 }}>
                <Button icon={<DownloadOutlined />} loading={backing} onClick={() => void downloadBackup()} block>
                  导出全库数据备份（JSON）
                </Button>
                <Radio.Group
                  value={restoreMode}
                  onChange={(e) => setRestoreMode(e.target.value as 'merge' | 'replace')}
                  size="small"
                  style={{ marginTop: 4 }}
                >
                  <Radio.Button value="merge">合并恢复（推荐）</Radio.Button>
                  <Radio.Button value="replace">覆盖恢复</Radio.Button>
                </Radio.Group>
                <Upload
                  accept="application/json,.json"
                  showUploadList={false}
                  beforeUpload={(f) => {
                    restoreBackup(f as unknown as File);
                    return Upload.LIST_IGNORE;
                  }}
                >
                  <Button icon={<UploadOutlined />} loading={restoring} block>
                    选择备份文件恢复
                  </Button>
                </Upload>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  合并恢复按主键更新、不删本库现有数据，适合「误删了点什么，补回来」；
                  覆盖恢复会先清空目标表再写入，等于回到备份那一刻。
                  两种模式都会写入审计。产物文件在 uploads 卷，恢复数据库不会自动恢复它。
                </Text>
                <Space.Compact block>
                  <Button style={{ flex: 1 }} onClick={() => void loadStorage()}>
                    {storage
                      ? `本租户产物 ${((storage.tenantUsedBytes ?? storage.usedBytes) / 1048576).toFixed(1)} / 配额 ${(storage.quotaBytes / 1048576).toFixed(0)} MB`
                      : '查看产物存储占用'}
                  </Button>
                  <Button danger loading={cleaning} disabled={!storage} onClick={() => void cleanup()}>
                    清理 30 天前未引用产物
                  </Button>
                </Space.Compact>
                {storage ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    卷内总占用 {(storage.usedBytes / 1048576).toFixed(1)} MB（含交付包、全库备份与未入库文件）；
                    配额按租户算，与上传闸门同一口径，所以「本租户产物」才是还能传的量。
                  </Text>
                ) : null}
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

      {/* 修改登录手机号：登录账号本身，不是成员资料 */}
      <Modal
        title="修改登录手机号"
        open={phoneModalOpen}
        onCancel={() => setPhoneModalOpen(false)}
        onOk={() => void phoneForm.submit()}
        okText="保存新手机号"
        confirmLoading={phoneLoading}
        destroyOnHidden
      >
        <Text type="secondary" style={{ fontSize: 12.5, display: 'block', marginBottom: 12 }}>
          手机号是你的登录账号，也是别人给你发消息、找你的联系方式。
          部署时预置的管理员手机号是公开示例值，建议第一时间换成自己的。
          改完当前会话会立即失效，请用新手机号重新登录。
        </Text>
        <Form form={phoneForm} layout="vertical" onFinish={changePhone} requiredMark={false}>
          <Form.Item
            name="phone"
            rules={[
              { required: true, message: '请输入新手机号' },
              { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不对（11 位，1 开头）' },
            ]}
          >
            <Input placeholder="新手机号" maxLength={11} />
          </Form.Item>
        </Form>
      </Modal>

      <Card title="账本明细" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        <Table<LedgerEntry>
          rowKey="id"
          dataSource={ledger}          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
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

    </div>
  );
}
