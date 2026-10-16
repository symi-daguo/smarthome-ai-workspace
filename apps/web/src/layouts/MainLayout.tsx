import {
  AuditOutlined,
  BookOutlined,
  BulbFilled,
  BulbOutlined,
  MoonFilled,
  CheckOutlined,
  FilePptOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  LeftOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MoreOutlined,
  PictureOutlined,
  RightOutlined,
  RobotOutlined,
  SettingOutlined,
  ShopOutlined,
  StarOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  VideoCameraOutlined,
  WalletOutlined, ApartmentOutlined, TeamOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  App as AntApp,
  Tooltip,
  Button,
  Divider,
  Drawer,
  Dropdown,
  Grid,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Typography,
  theme,
  type MenuProps,
} from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { trackRoute } from '../lib/errorContext';
import { api } from '../lib/api';
import { tokenToYuan } from '../lib/money';
import { BRAND_GRADIENT } from '../theme/tokens';
import { BrandMark } from '../components/BrandMark';
import { UserAvatar } from '../components/UserAvatar';
import { TaskBall } from '../components/TaskBall';
import { useAuth } from '../store/AuthContext';
import { useChatStore, type WorkbenchConversation } from '../store/ChatStore';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';

const { Text } = Typography;
const { useToken } = theme;

/** 使用指引弹窗内容（计费口径说明：额度由部署者按自有模型成本配置） */
const GUIDE_PRICE_ROWS = [
  { name: 'AI 对话 / 文案', price: '按额度扣费' },
  { name: 'AI 生图 / 生视频 / 方案', price: '按额度扣费（额度单价由部署者配置）' },
];

interface TokenBalance {
  tenantId: string;
  tokenBalance: number;
}

/** 侧栏"历史对话"中混排的方案记录（方案会话直接可见、可点回） */
interface PlanSidebarItem {
  id: string;
  title: string;
  pageCount: number;
  versionNo: number;
  updatedAt: string;
}

const THEME_ITEMS: { key: ThemeMode; label: string }[] = [
  { key: 'auto', label: '跟随系统' },
  { key: 'light', label: '浅色模式' },
  { key: 'dark', label: '深色模式' },
];

/** 顶栏额度/会员卡片的显示开关（0.1.54）。默认不显示 */
const SHOW_BILLING_KEY = 'show_billing';
export const SHOW_BILLING_EVENT = 'billing-visibility-changed';
/** 供设置页调用：写 localStorage 并广播（同标签页 storage 事件不触发） */
export function setShowBilling(next: boolean): void {
  localStorage.setItem(SHOW_BILLING_KEY, next ? '1' : '0');
  window.dispatchEvent(new Event(SHOW_BILLING_EVENT));
}

/** 顶栏额度胶囊（紫点 + 数字） */
function TokenPill(): ReactNode {
  const { token } = useToken();
  const navigate = useNavigate();
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    api<TokenBalance>('/api/tenants/current/tokens')
      .then((res) => setBalance(res.tokenBalance))
      .catch(() => setBalance(null));
  }, []);

  return (
    <Button
      type="text"
      size="small"
      onClick={() => navigate('/tokens')}
      style={{
        height: 32,
        padding: '0 12px',
        borderRadius: 16,
        background: token.colorPrimaryBg,
        color: token.colorText,
        fontWeight: 500,
      }}
    >
      <Space size={6}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: token.colorPrimary,
            display: 'inline-block',
          }}
        />
        <span>{balance === null ? '--' : tokenToYuan(balance)}</span>
      </Space>
    </Button>
  );
}

function formatConvTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 统一历史条目：工作台会话与智能方案按更新时间混排（侧栏历史） */
type HistoryItem =
  | { kind: 'conv'; ts: number; conv: WorkbenchConversation }
  | { kind: 'plan'; ts: number; plan: PlanSidebarItem };

export function MainLayout(): ReactNode {
  const { modal } = AntApp.useApp();
  const { token } = useToken();
  const { user, logout, refresh } = useAuth();
  const { message } = AntApp.useApp();
  const { mode, setMode } = useTheme();
  const { conversations, activeKey, setActiveKey, createNew, remove } = useChatStore();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    trackRoute(location.pathname);
  }, [location.pathname]);
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.lg ?? false;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [plans, setPlans] = useState<PlanSidebarItem[]>([]);
  /**
   * 额度胶囊与「开源说明」按钮：**默认隐藏**（0.1.54）。
   * 项目定位是开源免费自部署，这两个数字对使用者没有实际意义，却占着顶栏最显眼的位置，
   * 还容易被误读成「要先充值才能用」。留一个开关，需要看账的人可以在个人中心打开。
   */
  const [showBilling, setShowBilling] = useState(() => localStorage.getItem(SHOW_BILLING_KEY) === '1');
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === SHOW_BILLING_KEY) setShowBilling(e.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    // 同标签页内自定义事件（设置页改的是同一个窗口，storage 事件不跨标签页触发）
    const onToggle = (): void => setShowBilling(localStorage.getItem(SHOW_BILLING_KEY) === '1');
    window.addEventListener(SHOW_BILLING_EVENT, onToggle);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SHOW_BILLING_EVENT, onToggle);
    };
  }, []);

  // 侧栏历史列表需要方案记录；在路由切换时刷新，保证生成/编辑后及时更新
  useEffect(() => {
    api<PlanSidebarItem[]>('/api/plans')
      .then(setPlans)
      .catch(() => setPlans([]));
  }, [location.pathname]);

  // 首次登录自动弹出使用说明（按用户 id 记忆，仅弹一次）
  useEffect(() => {
    if (!user) return;
    const seenKey = `guide_seen_${user.id}`;
    if (!localStorage.getItem(seenKey)) {
      setGuideOpen(true);
      localStorage.setItem(seenKey, '1');
    }
  }, [user]);

  const historyItems = useMemo<HistoryItem[]>(
    () =>
      [
        ...conversations.map((c) => ({ kind: 'conv' as const, ts: c.updatedAt, conv: c })),
        ...plans.map((p) => ({ kind: 'plan' as const, ts: Date.parse(p.updatedAt), plan: p })),
      ].sort((a, b) => b.ts - a.ts),
    [conversations, plans],
  );

  const removePlan = (id: string, title: string): void => {
    modal.confirm({
      title: '删除该方案？',
      content: `方案「${title}」删除后分享链接立即失效，不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api(`/api/plans/${id}`, { method: 'DELETE' });
        setPlans((prev) => prev.filter((p) => p.id !== id));
      },
    });
  };

  // 命名说明：这里判的是 platform:billing:manage 权限（seed 里 tenant_admin 与 super_admin 都有），
  // 不是 super_admin 角色本身。叫 isSuperAdmin 会让后来者误以为只有超管可见，与 ModelConfig.tsx 的 canManageModels 也对不上。
  const canManageModels = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage')) ?? false;

  const menuItems: MenuProps['items'] = useMemo(() => {
    const creation: NonNullable<MenuProps['items']>[number] = {
      type: 'group',
      key: 'g-ai',
      label: 'AI 超能力',
      children: [
        { key: '/', icon: <HomeOutlined />, label: '工作台' },
        { key: '/order', icon: <AuditOutlined />, label: '开始接单' },
        { key: '/agents', icon: <RobotOutlined />, label: 'AI 智能体' },
        { key: '/image', icon: <PictureOutlined />, label: 'AI 生图' },
        { key: '/canvas', icon: <ApartmentOutlined />, label: 'AI 画布' },
        { key: '/video', icon: <VideoCameraOutlined />, label: 'AI 生视频' },
        { key: '/plan', icon: <FilePptOutlined />, label: '智能方案' },
        { key: '/products', icon: <ShopOutlined />, label: '产品中心' },
      ],
    };
    const toolbox: NonNullable<MenuProps['items']>[number] = {
      type: 'group',
      key: 'g-box',
      label: '智能百宝箱',
      children: [
        { key: '/treasure', icon: <ToolOutlined />, label: '智能百宝箱' },
        { key: '/knowledge', icon: <BookOutlined />, label: '我的知识库' },
        { key: '/works', icon: <FolderOpenOutlined />, label: '我的资料库' },
        { key: '/materials', icon: <StarOutlined />, label: '视频素材库' },
        { key: '/content', icon: <FileSearchOutlined />, label: '内容提取' },
      ],
    };
    // 个人中心人人可见；模型配置仅具备平台配置权限（开源自部署默认 tenant_admin 即有）时追加
    const systemChildren: NonNullable<MenuProps['items']> = [
      { key: '/team', icon: <TeamOutlined />, label: '团队与接入' },
      { key: '/tokens', icon: <WalletOutlined />, label: '个人中心' },
    ];
    if (canManageModels) systemChildren.push({ key: '/model-config', icon: <ThunderboltOutlined />, label: '模型配置' });
    const system: NonNullable<MenuProps['items']>[number] = {
      type: 'group',
      key: 'g-system',
      label: '系统管理',
      children: systemChildren,
    };
    return [creation, toolbox, system];
  }, [canManageModels]);

  const selectedKey = useMemo(() => {
    const p = location.pathname;
    if (p === '/') return '/';
    for (const k of ['/agents', '/canvas', '/image', '/video', '/plan', '/order', '/biography', '/materials', '/treasure', '/products', '/knowledge', '/works', '/content', '/team', '/tokens', '/model-config', '/lighting', '/lighting-diagnosis', '/feedback', '/vip']) {
      if (p.startsWith(k)) return k;
    }
    return '/';
  }, [location.pathname]);

  const go = (key: string): void => {
    navigate(key);
    setDrawerOpen(false);
  };

  const confirmRemove = (key: string): void => {
    const conv = conversations.find((c) => c.key === key);
    modal.confirm({
      title: '删除该会话？',
      content: `会话「${conv?.label ?? ''}」删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove(key),
    });
  };

  const gradientBtnStyle: React.CSSProperties = {
    height: 44,
    border: 'none',
    borderRadius: 10,
    fontWeight: 600,
    background: BRAND_GRADIENT,
    boxShadow: '0 4px 12px rgba(91, 91, 240, 0.25)',
  };

  /** 工作台名取当前租户；点标题可改（需 tenant:member:manage，后端会校验） */
  const tenantName =
    user?.memberships.find((m) => m.tenantId === user.activeTenantId)?.tenantName
    ?? user?.memberships[0]?.tenantName
    ?? '智能家居 AI 工作台';

  const renameTenant = async (): Promise<void> => {
    const next = window.prompt('工作台名称', tenantName);
    if (!next?.trim() || next.trim() === tenantName) return;
    try {
      await api('/api/tenants/current', { method: 'PATCH', body: JSON.stringify({ name: next.trim() }) });
      await refresh();
      message.success('已改名');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '改名失败');
    }
  };

  const sideContent: ReactNode = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部品牌行 */}
      <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 16px' }}>
        <BrandMark size={28} />
        <Tooltip title="点击改名">
          <Text
            strong
            style={{ fontSize: 14, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }}
            onClick={() => void renameTenant()}
          >
            {tenantName}
          </Text>
        </Tooltip>
        {isDesktop ? (
          <Button
            type="text"
            size="small"
            icon={<MenuFoldOutlined />}
            aria-label="收起侧栏"
            onClick={() => setCollapsed(true)}
          />
        ) : null}
      </div>

      {/* 渐变新对话按钮 + 短视频工作台 */}
      <div style={{ padding: '4px 12px 0' }}>
        <Button
          block
          type="primary"
          icon={<span style={{ fontSize: 16 }}>+</span>}
          style={gradientBtnStyle}
          onClick={() => {
            createNew();
            go('/');
          }}
        >
          新对话
        </Button>
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        <Button
          block
          type="primary"
          icon={<VideoCameraOutlined />}
          style={{ ...gradientBtnStyle, height: 40 }}
          onClick={() => go('/biography')}
        >
          短视频工作台
        </Button>
      </div>

      {/* 分组导航 */}
      <Menu
        theme="light"
        mode="inline"
        selectedKeys={[selectedKey]}
        items={menuItems}
        onClick={({ key }) => go(key)}
        style={{ borderInlineEnd: 0, padding: '0 8px' }}
      />

      {/* 历史对话 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 8px' }}>
        <Text type="secondary" style={{ fontSize: 12, padding: '12px 8px 4px', display: 'block' }}>
          历史对话
        </Text>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {historyItems.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12, padding: '8px', display: 'block' }}>
              暂无历史对话
            </Text>
          ) : (
            historyItems.map((item) => {
              if (item.kind === 'plan') {
                const p = item.plan;
                const active = location.pathname === '/plan' && location.search === `?id=${p.id}`;
                return (
                  <div
                    key={`plan-${p.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => go(`/plan?id=${p.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && go(`/plan?id=${p.id}`)}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: active ? token.colorPrimaryBg : 'transparent',
                      marginBottom: 2,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.title}
                      </div>
                      <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 2 }}>
                        智能方案 · {p.pageCount} 页文案 · 文案版本 {p.versionNo} · {formatConvTime(item.ts)}
                      </div>
                    </div>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [{ key: 'delete', label: '删除方案', danger: true }],
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation();
                          if (key === 'delete') removePlan(p.id, p.title);
                        },
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        aria-label="方案操作"
                        icon={<MoreOutlined style={{ fontSize: 14 }} />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Dropdown>
                  </div>
                );
              }
              const c = item.conv;
              const active = c.key === activeKey && location.pathname === '/';
              return (
                <div
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setActiveKey(c.key);
                    go('/');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setActiveKey(c.key);
                      go('/');
                    }
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: active ? token.colorPrimaryBg : 'transparent',
                    marginBottom: 2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.label}
                    </div>
                    <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 2 }}>
                      {c.agent ? `${c.agent} · ${formatConvTime(c.updatedAt)}` : `智居助手 · 通用对话 · ${formatConvTime(c.updatedAt)}`}
                    </div>
                  </div>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [{ key: 'delete', label: '删除会话', danger: true }],
                      onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        if (key === 'delete') confirmRemove(c.key);
                      },
                    }}
                  >
                    <Button
                      type="text"
                      size="small"
                      aria-label="会话操作"
                      icon={<MoreOutlined style={{ fontSize: 14 }} />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Dropdown>
                </div>
              );
            })
          )}
        </div>
      </div>

      <Divider style={{ margin: '8px 0' }} />

      {/* 底部个人中心卡 */}
      <div style={{ padding: '8px 12px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <UserAvatar user={user} size={36} cursor="pointer" onClick={() => navigate('/tokens')} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.displayName ?? '未命名'}
          </div>
          <Space size={4} split={<Divider type="vertical" style={{ margin: 0 }} />} style={{ fontSize: 12, color: token.colorTextTertiary }}>
            <span
              style={{ cursor: 'pointer' }}
              onClick={() => go('/tokens')}
            >
              额度
            </span>
            <span
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}
              onClick={() => go('/tokens')}
            >
              <SettingOutlined />
              设置
            </span>
            <Popconfirm title="确认退出登录？" okText="退出" cancelText="取消" onConfirm={logout}>
              <span style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <LogoutOutlined />
                退出
              </span>
            </Popconfirm>
          </Space>
        </div>
      </div>
    </div>
  );

  const userMenu: MenuProps = {
    items: [
      {
        key: 'tenant',
        disabled: true,
        label: (
          <Space direction="vertical" size={0}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前租户
            </Text>
            <Text>{user?.memberships[0]?.tenantName ?? '-'}</Text>
          </Space>
        ),
      },
      { type: 'divider' },
      ...THEME_ITEMS.map((item) => ({
        key: item.key,
        label: (
          <Space>
            <BulbOutlined />
            <span>{item.label}</span>
            {mode === item.key ? <CheckOutlined style={{ color: token.colorPrimary }} /> : null}
          </Space>
        ),
        onClick: () => setMode(item.key),
      })),
      { type: 'divider' },
      { key: 'profile', icon: <SettingOutlined />, label: '个人设置', onClick: () => go('/tokens') },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout },
    ],
  };

  const showSider = isDesktop && !collapsed;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {isDesktop ? (
        showSider ? (
          <Layout.Sider
            width={280}
            theme="light"
            style={{
              position: 'sticky',
              top: 0,
              height: '100vh',
              overflow: 'hidden',
              background: token.colorBgContainer,
              borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {sideContent}
          </Layout.Sider>
        ) : (
          <Layout.Sider
            width={48}
            collapsedWidth={48}
            theme="light"
            style={{
              position: 'sticky',
              top: 0,
              height: '100vh',
              background: token.colorBgContainer,
              borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 12 }}>
              <Button type="text" icon={<RightOutlined />} aria-label="展开侧栏" onClick={() => setCollapsed(false)} />
              <BrandMark size={28} />
            </div>
          </Layout.Sider>
        )
      ) : (
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={280}
          styles={{ body: { padding: 0, background: token.colorBgContainer } }}
          closable={false}
        >
          {sideContent}
        </Drawer>
      )}

      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 9,
            height: 56,
            padding: isDesktop ? '0 24px' : '0 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {!isDesktop ? (
            <Button type="text" icon={<MenuFoldOutlined />} onClick={() => setDrawerOpen(true)} />
          ) : null}

          {/* 全局返回：任何子页面都能退回上一页（无历史时回工作台） */}
          {location.pathname !== '/' ? (
            <Button
              type="text"
              icon={<LeftOutlined />}
              aria-label="返回上一页"
              onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
              style={{ color: token.colorTextSecondary }}
            >
              {isDesktop ? '返回' : null}
            </Button>
          ) : null}

          <div style={{ flex: 1 }} />

          {showBilling && <TokenPill />}
          {/* 主题切换：常驻顶栏，不再只藏在头像菜单里。
              明暗两套的卡片配色由 AntD 算法派生，这里只提供入口与当前态指示。 */}
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as ThemeMode)}
            options={[
              { label: '跟随', value: 'auto', icon: <BulbOutlined /> },
              { label: '浅色', value: 'light', icon: <BulbFilled /> },
              { label: '深色', value: 'dark', icon: <MoonFilled /> },
            ]}
            style={{ marginRight: 8 }}
          />
          <Button
            size="small"
            onClick={() => setGuideOpen(true)}
            style={{
              borderRadius: 16,
              background: token.colorInfoBg,
              border: 'none',
              color: token.colorInfoText,
              display: isDesktop ? 'inline-flex' : 'none',
            }}
          >
            使用指引
          </Button>
          <Modal
            title="使用说明"
            open={guideOpen}
            onCancel={() => setGuideOpen(false)}
            onOk={() => setGuideOpen(false)}
            okText="我知道了，开始使用"
            cancelButtonProps={{ style: { display: 'none' } }}
          >
            <Text style={{ display: 'block', marginBottom: 12 }}>
              开源自部署：额度由部署者分配、单价由部署者配置，不设付费墙。计费口径：
            </Text>
            {GUIDE_PRICE_ROWS.map((row) => (
              <div
                key={row.name}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  marginBottom: 8,
                }}
              >
                <Text>{row.name}</Text>
                <Text strong>{row.price}</Text>
              </div>
            ))}
            <Text type="secondary" style={{ fontSize: 12 }}>
              额度由部署者在后台发放，本部署不提供在线充值；一个公司可开通多个员工账号，共享额度账本，个人对话与资料相互隔离。
            </Text>
          </Modal>
          {showBilling && (
            <Button
              size="small"
              onClick={() => navigate('/vip')}
              style={{
                borderRadius: 16,
                background: BRAND_GRADIENT,
                border: 'none',
                color: '#ffffff',
                display: isDesktop ? 'inline-flex' : 'none',
              }}
            >
              开源说明
            </Button>
          )}

          <Dropdown menu={userMenu} trigger={['click']} placement="bottomRight">
            <Button
              type="text"
              aria-label="用户菜单"
              style={{ height: 40, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <UserAvatar user={user} size={32} />
              {isDesktop ? <Text>{user?.displayName ?? ''}</Text> : null}
            </Button>
          </Dropdown>
        </Layout.Header>

        <Layout.Content
          style={{
            background: token.colorBgLayout,
            padding: 0,
          }}
        >
          <div style={{ width: '100%', padding: location.pathname === '/' ? 0 : isDesktop ? 24 : 12 }}>
            <Outlet />
          </div>
        </Layout.Content>
      </Layout>

      <TaskBall />
    </Layout>
  );
}
