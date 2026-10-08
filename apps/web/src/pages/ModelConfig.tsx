import {
  ApiOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  CopyOutlined,
  DesktopOutlined,
  PictureOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { App as AntApp, Alert, Button, Card, Descriptions, Grid, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../store/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { BRAND_GRADIENT } from '../theme/tokens';

const { Paragraph, Text, Title } = Typography;

interface ProviderStatus {
  provider: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keyMasked: string | null;
  comfyWorkflow?: string;
}

interface ConfigStatus {
  chat: ProviderStatus;
  image: ProviderStatus;
  video: ProviderStatus;
}

interface TestResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

/** 云端 OpenAI 兼容 provider 目录（客户按需选一个填进 .env） */
const CLOUD_PROVIDERS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat / deepseek-reasoner', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus / qwen-max', keyUrl: 'https://bailian.console.aliyun.com' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', keyUrl: 'https://open.bigmodel.cn' },
  { name: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyUrl: 'https://platform.moonshot.cn' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', keyUrl: 'https://platform.minimaxi.com' },
];

/** 本地大模型 provider（OpenAI 兼容，填本机地址、key 填占位串） */
const LOCAL_PROVIDERS = [
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3 / llama3.2 …', install: 'ollama.com/download → ollama pull qwen3', keyNote: 'LLM_API_KEY 填任意串（如 ollama）' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '界面已加载的模型名', install: 'lmstudio.ai → 下载模型并开启本地服务器', keyNote: 'LLM_API_KEY 填任意串' },
  { name: 'vLLM', baseUrl: 'http://localhost:8000/v1', model: '启动时的 served-model-name', install: 'pip install vllm → vllm serve <model>', keyNote: 'LLM_API_KEY 填任意串' },
];

function KeyTag({ status }: { status: ProviderStatus }): ReactNode {
  return status.keyConfigured ? (
    <Tag icon={<CheckCircleFilled />} color="green">已配置 {status.keyMasked}</Tag>
  ) : (
    <Tag color="default">未配置 Key</Tag>
  );
}

function ProviderCard({ icon, title, status, extra }: { icon: ReactNode; title: string; status: ProviderStatus; extra?: ReactNode }): ReactNode {
  return (
    <Card
      style={{ height: '100%' }}
      styles={{ body: { padding: 18 } }}
      title={
        <Space>
          <span style={{ color: '#5B5BF0' }}>{icon}</span>
          {title}
        </Space>
      }
      extra={<KeyTag status={status} />}
    >
      <Descriptions column={1} size="small" colon={false} labelStyle={{ width: 72, color: 'rgba(0,0,0,0.45)' }}>
        <Descriptions.Item label="Provider">{status.provider}</Descriptions.Item>
        <Descriptions.Item label="Base URL"><Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{status.baseUrl}</Text></Descriptions.Item>
        <Descriptions.Item label="模型">{status.model}</Descriptions.Item>
        {status.comfyWorkflow ? <Descriptions.Item label="工作流"><Text code style={{ fontSize: 12 }}>{status.comfyWorkflow}</Text></Descriptions.Item> : null}
      </Descriptions>
      {extra}
    </Card>
  );
}

function CopyBlock({ text }: { text: string }): ReactNode {
  const { message } = AntApp.useApp();
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => message.success('已复制，粘贴到你的 .env'),
      () => message.error('复制失败，请手动选择'),
    );
  }, [text, message]);
  return (
    <div style={{ position: 'relative' }}>
      <pre
        style={{
          background: '#0d1117',
          color: '#c9d1d9',
          padding: '14px 16px',
          borderRadius: 10,
          fontSize: 12.5,
          lineHeight: 1.7,
          overflowX: 'auto',
          margin: 0,
        }}
      >
        {text}
      </pre>
      <Button size="small" icon={<CopyOutlined />} onClick={copy} style={{ position: 'absolute', top: 8, right: 8 }}>
        复制
      </Button>
    </div>
  );
}

export function ModelConfig(): ReactNode {
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const isWide = screens.lg ?? false;
  const { user } = useAuth();
  const isSuperAdmin = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage'));

  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!isSuperAdmin) return;
    api<ConfigStatus>('/api/admin/model-config')
      .then(setStatus)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [isSuperAdmin, message]);

  if (!isSuperAdmin) {
    return (
      <Card>
        <Alert type="warning" showIcon message="无权访问" description="仅 super_admin 角色可配置与测试模型服务。" />
      </Card>
    );
  }

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<TestResult>('/api/admin/model-config/test-chat', { method: 'POST' });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', paddingBottom: 32 }}>
      <PageHeader
        title="模型配置"
        description="本项目开源自部署：对话走 OpenAI 兼容协议，可接任意国内外云端大模型或本地模型；生图支持 MiniMax / OpenAI / 本地 ComfyUI。密钥只写在 .env，前端仅只读展示脱敏状态。"
      />

      {loading ? (
        <Card style={{ textAlign: 'center', padding: 40 }}>
          <Spin /> <Text type="secondary">读取当前配置…</Text>
        </Card>
      ) : status ? (
        <>
          {/* 当前配置概览 */}
          <div style={{ display: 'grid', gridTemplateColumns: isWide ? 'repeat(3, minmax(0, 1fr))' : '1fr', gap: 16, marginBottom: 8 }}>
            <ProviderCard icon={<ApiOutlined />} title="对话" status={status.chat} />
            <ProviderCard icon={<PictureOutlined />} title="生图" status={status.image} />
            <ProviderCard icon={<VideoCameraOutlined />} title="生视频" status={status.video} />
          </div>

          {/* 连通性测试 */}
          <Card style={{ margin: '16px 0' }} styles={{ body: { padding: 18 } }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space align="center">
                <Title level={5} style={{ margin: 0 }}>对话连通性测试</Title>
                <Button type="primary" loading={testing} onClick={() => void runTest()} style={{ background: BRAND_GRADIENT, border: 'none' }}>
                  发起测试请求
                </Button>
              </Space>
              {testing ? <Text type="secondary">正在向当前对话 provider 发送一条 ping…</Text> : null}
              {testResult ? (
                testResult.ok ? (
                  <Alert type="success" showIcon message={`连通正常 · model=${testResult.model} · 延迟 ${testResult.latencyMs}ms`} />
                ) : (
                  <Alert type="error" showIcon message="连通失败" description={testResult.error} />
                )
              ) : (
                <Text type="secondary">测试仅发送一条极短请求验证 Base URL 与 Key 是否可用，不消耗实质额度。</Text>
              )}
            </Space>
          </Card>

          {/* 配置引导 */}
          <Card styles={{ body: { paddingTop: 8 } }}>
            <Tabs
              items={[
                {
                  key: 'cloud',
                  label: <Space><CloudServerOutlined />云端大模型</Space>,
                  children: (
                    <Space direction="vertical" size={16} style={{ width: '100%' }}>
                      <Text type="secondary">填任意一个 OpenAI 兼容端点即可。在 .env 设置 <Text code>LLM_BASE_URL</Text> + <Text code>LLM_API_KEY</Text>（可选 <Text code>LLM_MODEL</Text> 锁定模型），重启后端生效。</Text>
                      <Table
                        size="small"
                        pagination={false}
                        scroll={{ x: 640 }}
                        dataSource={CLOUD_PROVIDERS}
                        rowKey="name"
                        columns={[
                          { title: 'Provider', dataIndex: 'name', width: 150 },
                          { title: 'Base URL', dataIndex: 'baseUrl', render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
                          { title: '推荐模型', dataIndex: 'model', width: 200 },
                          { title: '获取 Key', dataIndex: 'keyUrl', render: (v: string) => <a href={v} target="_blank" rel="noreferrer">控制台</a> },
                        ]}
                      />
                      <CopyBlock text={'LLM_BASE_URL=https://api.deepseek.com\nLLM_API_KEY=sk-你的key\nLLM_MODEL=deepseek-chat'} />
                    </Space>
                  ),
                },
                {
                  key: 'local',
                  label: <Space><DesktopOutlined />本地大模型</Space>,
                  children: (
                    <Space direction="vertical" size={16} style={{ width: '100%' }}>
                      <Text type="secondary">本地跑 OpenAI 兼容服务（Ollama / LM Studio / vLLM），<Text code>LLM_BASE_URL</Text> 填本机地址、<Text code>LLM_API_KEY</Text> 填任意占位串即可，数据不出本机。</Text>
                      <Table
                        size="small"
                        pagination={false}
                        scroll={{ x: 720 }}
                        dataSource={LOCAL_PROVIDERS}
                        rowKey="name"
                        columns={[
                          { title: '工具', dataIndex: 'name', width: 110 },
                          { title: 'Base URL', dataIndex: 'baseUrl', render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
                          { title: '模型名', dataIndex: 'model', width: 180 },
                          { title: '安装 / 启动', dataIndex: 'install' },
                        ]}
                      />
                      <CopyBlock text={'LLM_BASE_URL=http://localhost:11434/v1\nLLM_API_KEY=ollama\nLLM_MODEL=qwen3'} />
                    </Space>
                  ),
                },
                {
                  key: 'image',
                  label: <Space><PictureOutlined />生图 / ComfyUI</Space>,
                  children: (
                    <Space direction="vertical" size={16} style={{ width: '100%' }}>
                      <Text type="secondary">用 <Text code>IMAGE_PROVIDER</Text> 切换出图后端：<Text code>minimax</Text>（默认）/ <Text code>openai</Text>（gpt-image-1 等）/ <Text code>comfyui</Text>（本地 ComfyUI，配 Stable Diffusion / Flux 等任意工作流）。</Text>
                      <Alert
                        type="info"
                        showIcon
                        message="ComfyUI 接入步骤"
                        description={
                          <ol style={{ margin: 0, paddingLeft: 20 }}>
                            <li>本机安装并启动 ComfyUI（默认 <Text code>http://127.0.0.1:8188</Text>），放好模型权重</li>
                            <li>在 ComfyUI 里搭好文生图工作流，菜单 <Text code>Workflow → Export (API)</Text> 导出 JSON</li>
                            <li>把导出的 JSON 保存为 <Text code>comfyui-workflow.json</Text>（项目已内置一份 SD1.5 模板）</li>
                            <li>设置 <Text code>IMAGE_PROVIDER=comfyui</Text> 与 <Text code>COMFYUI_BASE_URL</Text>，重启后端</li>
                          </ol>
                        }
                      />
                      <CopyBlock text={'IMAGE_PROVIDER=comfyui\nCOMFYUI_BASE_URL=http://127.0.0.1:8188\nCOMFYUI_WORKFLOW_PATH=./comfyui-workflow.json'} />
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
            生视频当前走 MiniMax Director（T2V/I2V-01-Director），需在 .env 配置 <Text code>MiniMax_API_KEY</Text>。所有 provider 改完 .env 后需重启后端容器（<Text code>docker compose up -d api</Text>）生效。
          </Paragraph>
        </>
      ) : null}
    </div>
  );
}
