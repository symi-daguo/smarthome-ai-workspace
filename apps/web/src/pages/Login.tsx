import {
  CheckCircleFilled,
  EyeInvisibleOutlined,
  EyeTwoTone,
  MoonOutlined,
  SunOutlined,
  SwapOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Grid,
  Input,
  Space,
  Tabs,
  Typography,
  theme,
} from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeProvider';

const { Title, Text, Paragraph } = Typography;

const BRAND_SOLID = '#5B5BF0';

const VALUE_POINTS = ['智能方案、效果图、灯光场景、营销文案，全链路 AI 生成', '三档会员与统一 token 计费，用量透明可控', '多租户与细粒度权限，团队协作开箱即用'];

const ERROR_LABEL: Record<string, string> = {
  INVALID_CREDENTIALS: '手机号或密码错误',
  PHONE_EXISTS: '该手机号已注册，请直接登录',
  RBAC_NOT_SEEDED: '系统角色未初始化，请联系管理员',
  USER_NOT_FOUND: '用户不存在',
  VALIDATION_FAILED: '输入信息校验未通过，请检查后重试',
};

const PHONE_RULE = [
  { required: true, message: '请输入手机号' },
  { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的 11 位手机号' },
];

function ThemeSwitch(): ReactNode {
  const { mode, setMode } = useTheme();
  const order = { auto: 'light', light: 'dark', dark: 'auto' } as const;
  const icon = mode === 'dark' ? <MoonOutlined /> : mode === 'light' ? <SunOutlined /> : <SwapOutlined />;
  const label = mode === 'dark' ? '深色' : mode === 'light' ? '浅色' : '跟随系统';
  return (
    <Button
      type="text"
      icon={icon}
      onClick={() => setMode(order[mode])}
      style={{ position: 'fixed', top: 16, right: 24, zIndex: 10 }}
    >
      {label}
    </Button>
  );
}

export function Login(): ReactNode {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();

  const showBrandPanel = screens.lg ?? false;

  const translateError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    return ERROR_LABEL[raw] ?? raw;
  };

  const guardAgreement = (): boolean => {
    if (!agreed) {
      setError('请先阅读并同意《用户协议》与《隐私政策》');
      return false;
    }
    return true;
  };

  const onLogin = async (values: { phone: string; password: string }): Promise<void> => {
    if (!guardAgreement()) return;
    setError(null);
    setLoading(true);
    try {
      await login(values.phone, values.password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(translateError(err));
    } finally {
      setLoading(false);
    }
  };

  const onRegister = async (values: {
    phone: string;
    password: string;
    displayName: string;
    tenantName?: string;
  }): Promise<void> => {
    if (!guardAgreement()) return;
    setError(null);
    setLoading(true);
    try {
      await register(values);
      navigate('/', { replace: true });
    } catch (err) {
      setError(translateError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: token.colorBgContainer }}>
      <ThemeSwitch />

      {showBrandPanel ? (
        <section
          style={{
            width: '46%',
            flex: 'none',
            background: BRAND_SOLID,
            color: '#ffffff',
            padding: '56px 52px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <Space size={12} align="center">
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: token.borderRadius,
                background: 'rgba(255,255,255,0.16)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ThunderboltFilled style={{ color: '#fff', fontSize: 20 }} />
            </div>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: 600 }}>智能家居 AI SaaS</Text>
          </Space>

          <div>
            <Title style={{ color: '#fff', fontSize: 34, lineHeight: 1.35, marginBottom: 28 }}>
              让每一个智能家居方案
              <br />
              都有 AI 加持
            </Title>
            <Space direction="vertical" size={16}>
              {VALUE_POINTS.map((point) => (
                <Space key={point} size={12} align="start">
                  <CheckCircleFilled style={{ color: 'rgba(255,255,255,0.85)', fontSize: 18, marginTop: 3 }} />
                  <Text style={{ color: 'rgba(255,255,255,0.88)', fontSize: 15, lineHeight: 1.6 }}>{point}</Text>
                </Space>
              ))}
            </Space>
          </div>

          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
            开源自部署 · 模型自选 · © 2026 智能家居 AI 工作台
          </Text>
        </section>
      ) : null}

      <section style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 392 }}>
          {!showBrandPanel ? (
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <Space size={10} align="center">
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: token.borderRadius,
                    background: token.colorPrimary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <ThunderboltFilled style={{ color: '#fff', fontSize: 20 }} />
                </div>
                <Text strong style={{ fontSize: 18 }}>智能家居 AI SaaS</Text>
              </Space>
            </div>
          ) : null}

          <Title level={3} style={{ marginBottom: 4 }}>
            {tab === 'login' ? '欢迎回来' : '创建账号'}
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 20 }}>
            {tab === 'login' ? '登录后继续你的 AI 创作' : '注册即自动开通团队，并赠送 80,000 token 体验额度'}
          </Paragraph>

          {error ? (
            <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
          ) : null}

          <Tabs
            activeKey={tab}
            onChange={(key) => {
              setTab(key as 'login' | 'register');
              setError(null);
            }}
            items={[
              {
                key: 'login',
                label: '登录',
                children: (
                  <Form form={loginForm} layout="vertical" onFinish={onLogin} requiredMark={false}>
                    <Form.Item name="phone" label="手机号" rules={PHONE_RULE}>
                      <Input placeholder="请输入手机号" size="large" maxLength={11} autoComplete="tel" />
                    </Form.Item>
                    <Form.Item
                      name="password"
                      label="密码"
                      rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '密码至少 8 位' }]}
                    >
                      <Input.Password
                        placeholder="请输入密码"
                        size="large"
                        iconRender={(visible) => (visible ? <EyeTwoTone /> : <EyeInvisibleOutlined />)}
                      />
                    </Form.Item>
                    <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginBottom: 16 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        我已阅读并同意
                        <a onClick={(e) => e.preventDefault()}>《用户协议》</a>与
                        <a onClick={(e) => e.preventDefault()}>《隐私政策》</a>
                      </Text>
                    </Checkbox>
                    <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                      登录
                    </Button>
                  </Form>
                ),
              },
              {
                key: 'register',
                label: '注册',
                children: (
                  <Form form={registerForm} layout="vertical" onFinish={onRegister} requiredMark={false}>
                    <Form.Item
                      name="displayName"
                      label="姓名 / 昵称"
                      rules={[{ required: true, message: '请输入姓名或昵称' }, { max: 20 }]}
                    >
                      <Input placeholder="例如：张设计师" size="large" maxLength={20} />
                    </Form.Item>
                    <Form.Item name="phone" label="手机号" rules={PHONE_RULE}>
                      <Input placeholder="用于登录的手机号" size="large" maxLength={11} autoComplete="tel" />
                    </Form.Item>
                    <Form.Item
                      name="password"
                      label="设置密码"
                      rules={[{ required: true, message: '请设置密码' }, { min: 8, message: '密码至少 8 位' }]}
                    >
                      <Input.Password placeholder="至少 8 位" size="large" />
                    </Form.Item>
                    <Form.Item name="tenantName" label="团队名称（可选）">
                      <Input placeholder="不填将自动创建" size="large" maxLength={30} />
                    </Form.Item>
                    <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginBottom: 16 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        我已阅读并同意
                        <a onClick={(e) => e.preventDefault()}>《用户协议》</a>与
                        <a onClick={(e) => e.preventDefault()}>《隐私政策》</a>
                      </Text>
                    </Checkbox>
                    <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                      注册并进入
                    </Button>
                  </Form>
                ),
              },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
