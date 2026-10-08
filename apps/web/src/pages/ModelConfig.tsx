import {
  ApiOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  DeleteOutlined,
  DesktopOutlined,
  PictureOutlined,
  ReloadOutlined,
  SaveOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Form,
  Grid,
  Input,
  Radio,
  Row,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../store/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { BRAND_GRADIENT } from '../theme/tokens';

const { Text, Title } = Typography;

interface ProviderView {
  provider: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keyMasked: string | null;
  source: 'db' | 'env';
  comfyBaseUrl?: string;
  workflowPath?: string;
  promptNode?: string;
  negativeNode?: string;
  latentNode?: string;
  seedNode?: string;
}

interface ConfigStatus {
  chat: ProviderView;
  image: ProviderView;
  video: ProviderView;
}

interface TestResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

interface ChatForm {
  baseUrl: string;
  apiKey: string;
  model: string;
}
interface ImageForm {
  provider: 'minimax' | 'openai' | 'comfyui';
  baseUrl: string;
  apiKey: string;
  model: string;
  comfyBaseUrl: string;
  workflowPath: string;
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  seedNode: string;
}
interface VideoForm {
  baseUrl: string;
  apiKey: string;
}

/** 云端 OpenAI 兼容 provider 目录（点「选用」一键填入表单） */
const CLOUD_PROVIDERS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyUrl: 'https://bailian.console.aliyun.com' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', keyUrl: 'https://open.bigmodel.cn' },
  { name: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyUrl: 'https://platform.moonshot.cn' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', keyUrl: 'https://platform.minimaxi.com' },
];

/** 本地大模型 provider（OpenAI 兼容，key 填任意占位串） */
const LOCAL_PROVIDERS = [
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3', install: 'ollama.com/download → ollama pull qwen3' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '界面已加载的模型名', install: 'lmstudio.ai → 下载模型并开启本地服务器' },
  { name: 'vLLM', baseUrl: 'http://localhost:8000/v1', model: 'served-model-name', install: 'pip install vllm → vllm serve <model>' },
];

function StatusTag({ view }: { view: ProviderView }): ReactNode {
  return (
    <Space size={6} wrap>
      {view.keyConfigured ? (
        <Tag icon={<CheckCircleFilled />} color="green" style={{ marginInlineEnd: 0 }}>
          Key 已配置{view.keyMasked ? ` ${view.keyMasked}` : ''}
        </Tag>
      ) : (
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>Key 未配置</Tag>
      )}
      <Tag color={view.source === 'db' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
        {view.source === 'db' ? '在线配置生效' : '.env 默认'}
      </Tag>
    </Space>
  );
}

function TestAlert({ result }: { result: TestResult | null }): ReactNode {
  if (!result) return null;
  return result.ok ? (
    <Alert
      type="success"
      showIcon
      message={result.model ? `连通正常 · model=${result.model} · 延迟 ${result.latencyMs}ms` : `连通正常 · ${result.detail ?? ''}`}
      style={{ marginTop: 12 }}
    />
  ) : (
    <Alert type="error" showIcon message="连通失败" description={result.error} style={{ marginTop: 12 }} />
  );
}

export function ModelConfig(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const isWide = screens.md ?? false;
  const { user } = useAuth();
  const isSuperAdmin = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage'));

  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<{ chat: TestResult | null; image: TestResult | null; video: TestResult | null }>({ chat: null, image: null, video: null });
  const [activeTab, setActiveTab] = useState('cloud');

  const [chatForm] = Form.useForm<ChatForm>();
  const [imageForm] = Form.useForm<ImageForm>();
  const [videoForm] = Form.useForm<VideoForm>();

  const load = useCallback(async (): Promise<void> => {
    const s = await api<ConfigStatus>('/api/admin/model-config');
    setStatus(s);
    chatForm.setFieldsValue({ baseUrl: s.chat.baseUrl, apiKey: '', model: s.chat.model.startsWith('（') ? '' : s.chat.model });
    imageForm.setFieldsValue({
      provider: s.image.provider.includes('ComfyUI') ? 'comfyui' : s.image.provider.includes('OpenAI') ? 'openai' : 'minimax',
      baseUrl: s.image.baseUrl,
      apiKey: '',
      model: s.image.model,
      comfyBaseUrl: s.image.comfyBaseUrl ?? '',
      workflowPath: s.image.workflowPath ?? '',
      promptNode: s.image.promptNode ?? '',
      negativeNode: s.image.negativeNode ?? '',
      latentNode: s.image.latentNode ?? '',
      seedNode: s.image.seedNode ?? '',
    });
    videoForm.setFieldsValue({ baseUrl: s.video.baseUrl, apiKey: '' });
  }, [chatForm, imageForm, videoForm]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    load()
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [isSuperAdmin, load, message]);

  if (!isSuperAdmin) {
    return (
      <Card>
        <Alert type="warning" showIcon message="无权访问" description="仅 super_admin 角色可配置与测试模型服务。" />
      </Card>
    );
  }

  const save = async (scope: 'chat' | 'image' | 'video'): Promise<void> => {
    const form = scope === 'chat' ? chatForm : scope === 'image' ? imageForm : videoForm;
    let values: Record<string, string>;
    try {
      values = await form.validateFields() as unknown as Record<string, string>;
    } catch {
      return;
    }
    setSaving(scope);
    try {
      await api(`/api/admin/model-config/${scope}`, { method: 'PUT', body: JSON.stringify(values) });
      message.success('已保存，即时生效（无需重启）');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const runTest = async (scope: 'chat' | 'image' | 'video'): Promise<void> => {
    setTesting(scope);
    setResults((r) => ({ ...r, [scope]: null }));
    try {
      const r = await api<TestResult>(`/api/admin/model-config/test-${scope}`, { method: 'POST' });
      setResults((prev) => ({ ...prev, [scope]: r }));
    } catch (e) {
      setResults((prev) => ({ ...prev, [scope]: { ok: false, error: (e as Error).message } }));
    } finally {
      setTesting(null);
    }
  };

  const resetScope = (scope: 'chat' | 'image' | 'video', label: string): void => {
    modal.confirm({
      title: `恢复「${label}」的 .env 默认？`,
      content: '将删除该能力的在线配置（含已存 API Key），回退读取 .env。此操作不可撤销。',
      okText: '确认恢复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api(`/api/admin/model-config/${scope}`, { method: 'DELETE' });
        message.success('已恢复 .env 默认');
        await load();
      },
    });
  };

  /** 预设一键填入对话表单 */
  const applyPreset = (baseUrl: string, model: string): void => {
    chatForm.setFieldsValue({ baseUrl, model });
    message.success('已填入表单，补上 API Key 后点「保存配置」');
  };

  const imageProvider = Form.useWatch('provider', imageForm);

  const actionButtons = (scope: 'chat' | 'image' | 'video', label: string): ReactNode => (
    <Space wrap style={{ marginTop: 4 }}>
      <Button type="primary" icon={<SaveOutlined />} loading={saving === scope} onClick={() => void save(scope)} style={{ background: BRAND_GRADIENT, border: 'none' }}>
        保存配置
      </Button>
      <Button icon={<ReloadOutlined />} loading={testing === scope} onClick={() => void runTest(scope)}>
        连通性测试
      </Button>
      {status?.[scope].source === 'db' ? (
        <Button danger type="text" icon={<DeleteOutlined />} onClick={() => resetScope(scope, label)}>
          恢复 .env 默认
        </Button>
      ) : null}
    </Space>
  );

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', paddingBottom: 32 }}>
      <PageHeader
        title="模型配置"
        description="在线配置对话 / 生图 / 生视频的大模型：支持国内外云端 API 与本地模型（Ollama / LM Studio / vLLM / ComfyUI）。保存即生效，配置持久化到数据库并优先于 .env。"
      />

      {loading ? (
        <Card style={{ textAlign: 'center', padding: 40 }}>
          <Spin /> <Text type="secondary">读取当前配置…</Text>
        </Card>
      ) : status ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="配置优先级：本页保存的在线配置 > .env 默认值。API Key 保存后不再回显（仅显示末四位），留空保存表示保持原 Key 不变。"
          />

          {/* —— 对话 —— */}
          <Card
            title={<Space><ApiOutlined style={{ color: '#5B5BF0' }} />对话大模型（OpenAI 兼容协议）</Space>}
            extra={<StatusTag view={status.chat} />}
            styles={{ body: { padding: 18 } }}
          >
            <Form form={chatForm} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 4 } : undefined} wrapperCol={isWide ? { span: 20 } : undefined}>
              <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请填写 Base URL' }, { pattern: /^https?:\/\/.+/, message: '需以 http:// 或 https:// 开头' }]} extra="云端填服务商地址，本地填 http://localhost:端口/v1">
                <Input placeholder="https://api.deepseek.com" allowClear />
              </Form.Item>
              <Form.Item name="apiKey" label="API Key" extra={status.chat.keyConfigured ? `已保存（${status.chat.keyMasked}），留空则保持不变` : '本地 Ollama / LM Studio 填任意占位串即可'}>
                <Input.Password placeholder="sk-…" autoComplete="off" allowClear />
              </Form.Item>
              <Form.Item name="model" label="模型" extra="可选：锁定全局模型；留空则跟随各功能默认（对话默认 MiniMax-M3）">
                <Input placeholder="deepseek-chat / qwen-plus / qwen3 …" allowClear />
              </Form.Item>
            </Form>
            {actionButtons('chat', '对话')}
            <TestAlert result={results.chat} />
          </Card>

          {/* —— 生图 —— */}
          <Card
            title={<Space><PictureOutlined style={{ color: '#5B5BF0' }} />生图服务</Space>}
            extra={<StatusTag view={status.image} />}
            styles={{ body: { padding: 18 } }}
          >
            <Form form={imageForm} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 4 } : undefined} wrapperCol={isWide ? { span: 20 } : undefined}>
              <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="minimax">MiniMax（云端）</Radio.Button>
                  <Radio.Button value="openai">OpenAI 兼容</Radio.Button>
                  <Radio.Button value="comfyui">ComfyUI（本地）</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {imageProvider === 'comfyui' ? (
                <>
                  <Form.Item name="comfyBaseUrl" label="ComfyUI 地址" rules={[{ required: true, message: '请填写 ComfyUI 服务地址' }, { pattern: /^https?:\/\/.+/, message: '需以 http:// 开头' }]} extra="本机默认 http://127.0.0.1:8188">
                    <Input placeholder="http://127.0.0.1:8188" allowClear />
                  </Form.Item>
                  <Form.Item name="workflowPath" label="工作流 JSON" extra="ComfyUI「Workflow → Export (API)」导出的文件路径（相对 api 进程工作目录），默认使用项目内置 SD 模板">
                    <Input placeholder="./comfyui-workflow.json" allowClear />
                  </Form.Item>
                  <Row gutter={12}>
                    {(['promptNode', 'negativeNode', 'latentNode', 'seedNode'] as const).map((node, i) => (
                      <Col span={isWide ? 6 : 12} key={node}>
                        <Form.Item name={node} label={['正向节点', '负向节点', '尺寸节点', '种子节点'][i]} extra="节点 id">
                          <Input placeholder={['6', '7', '5', '3'][i]} allowClear />
                        </Form.Item>
                      </Col>
                    ))}
                  </Row>
                </>
              ) : (
                <>
                  <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请填写 Base URL' }, { pattern: /^https?:\/\/.+/, message: '需以 http:// 开头' }]}>
                    <Input placeholder={imageProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.minimaxi.com/v1'} allowClear />
                  </Form.Item>
                  <Form.Item name="apiKey" label="API Key" extra={status.image.keyConfigured ? `已保存（${status.image.keyMasked}），留空则保持不变` : undefined}>
                    <Input.Password placeholder="sk-…" autoComplete="off" allowClear />
                  </Form.Item>
                  <Form.Item name="model" label="模型">
                    <Input placeholder={imageProvider === 'openai' ? 'gpt-image-1' : 'image-01'} allowClear />
                  </Form.Item>
                </>
              )}
            </Form>
            {actionButtons('image', '生图')}
            <TestAlert result={results.image} />
          </Card>

          {/* —— 生视频 —— */}
          <Card
            title={<Space><VideoCameraOutlined style={{ color: '#5B5BF0' }} />生视频服务（MiniMax Director）</Space>}
            extra={<StatusTag view={status.video} />}
            styles={{ body: { padding: 18 } }}
          >
            <Form form={videoForm} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 4 } : undefined} wrapperCol={isWide ? { span: 20 } : undefined}>
              <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请填写 Base URL' }, { pattern: /^https?:\/\/.+/, message: '需以 http:// 开头' }]}>
                <Input placeholder="https://api.minimaxi.com/v1" allowClear />
              </Form.Item>
              <Form.Item name="apiKey" label="API Key" extra={status.video.keyConfigured ? `已保存（${status.video.keyMasked}），留空则保持不变` : 'T2V/I2V-01-Director 走 MiniMax 平台，与对话可共用同一 Key'}>
                <Input.Password placeholder="sk-…" autoComplete="off" allowClear />
              </Form.Item>
            </Form>
            {actionButtons('video', '生视频')}
            <TestAlert result={results.video} />
          </Card>

          {/* —— 接入指南 —— */}
          <Card title="接入指南" styles={{ body: { paddingTop: 8 } }}>
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
              items={[
                {
                  key: 'cloud',
                  label: <Space><CloudServerOutlined />云端大模型</Space>,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Text type="secondary">任选一家服务商，点「选用」把地址与模型填入上方对话配置表单，再到其控制台创建 API Key 粘贴保存即可。</Text>
                      <Table
                        size="small"
                        pagination={false}
                        scroll={{ x: 560 }}
                        dataSource={CLOUD_PROVIDERS}
                        rowKey="name"
                        columns={[
                          { title: 'Provider', dataIndex: 'name', width: 170 },
                          { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
                          { title: '推荐模型', dataIndex: 'model', width: 130 },
                          { title: '获取 Key', dataIndex: 'keyUrl', width: 80, render: (v: string) => <a href={v} target="_blank" rel="noreferrer">控制台</a> },
                          { title: '', key: 'use', width: 70, render: (_: unknown, r: (typeof CLOUD_PROVIDERS)[number]) => <Button size="small" onClick={() => applyPreset(r.baseUrl, r.model)}>选用</Button> },
                        ]}
                      />
                    </Space>
                  ),
                },
                {
                  key: 'local',
                  label: <Space><DesktopOutlined />本地大模型</Space>,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Text type="secondary">本机跑 OpenAI 兼容服务（数据不出本机），点「选用」填入地址，API Key 填任意占位串（如 ollama）保存即可。</Text>
                      <Table
                        size="small"
                        pagination={false}
                        scroll={{ x: 560 }}
                        dataSource={LOCAL_PROVIDERS}
                        rowKey="name"
                        columns={[
                          { title: '工具', dataIndex: 'name', width: 100 },
                          { title: 'Base URL', dataIndex: 'baseUrl', width: 200, render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
                          { title: '模型名', dataIndex: 'model', width: 150 },
                          { title: '安装 / 启动', dataIndex: 'install', ellipsis: true },
                          { title: '', key: 'use', width: 70, render: (_: unknown, r: (typeof LOCAL_PROVIDERS)[number]) => <Button size="small" onClick={() => applyPreset(r.baseUrl, r.model)}>选用</Button> },
                        ]}
                      />
                      <Divider style={{ margin: '4px 0' }} />
                      <Descriptions size="small" column={1} items={[
                        { key: '1', label: 'ComfyUI（本地生图）', children: '① 本机安装启动 ComfyUI（默认 http://127.0.0.1:8188）→ ② 搭好工作流，菜单 Workflow → Export (API) 导出 JSON → ③ 存为 comfyui-workflow.json → ④ 上方生图卡片选 ComfyUI 填地址保存。项目已内置一份 SD1.5 模板可直接用。' },
                      ]} />
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card size="small" styles={{ body: { padding: '12px 18px' } }}>
            <Descriptions
              size="small"
              column={isWide ? 3 : 1}
              title={<Title level={5} style={{ margin: 0 }}>当前生效配置</Title>}
              items={[
                { key: 'c', label: '对话', children: `${status.chat.provider} · ${status.chat.baseUrl}` },
                { key: 'i', label: '生图', children: `${status.image.provider} · ${status.image.provider.includes('ComfyUI') ? (status.image.comfyBaseUrl ?? '') : status.image.baseUrl}` },
                { key: 'v', label: '生视频', children: `${status.video.provider} · ${status.video.baseUrl}` },
              ]}
            />
          </Card>
        </Space>
      ) : null}
    </div>
  );
}
