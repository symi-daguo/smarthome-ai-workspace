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

const { Text } = Typography;

interface ProviderView {
  provider: string;
  providerKey: string;
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
}
interface ComfyForm {
  comfyBaseUrl: string;
  workflowPath: string;
  promptNode: string;
  negativeNode: string;
  latentNode: string;
  seedNode: string;
}
interface VideoForm {
  provider: 'minimax' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 云端 OpenAI 兼容对话 provider 目录（点「选用」一键填入对话表单） */
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
  const [results, setResults] = useState<{ chat: TestResult | null; image: TestResult | null; comfy: TestResult | null; video: TestResult | null }>({ chat: null, image: null, comfy: null, video: null });

  const [chatForm] = Form.useForm<ChatForm>();
  const [imageForm] = Form.useForm<ImageForm>();
  const [comfyForm] = Form.useForm<ComfyForm>();
  const [videoForm] = Form.useForm<VideoForm>();

  const load = useCallback(async (): Promise<void> => {
    const s = await api<ConfigStatus>('/api/admin/model-config');
    setStatus(s);
    chatForm.setFieldsValue({ baseUrl: s.chat.baseUrl, apiKey: '', model: s.chat.model.startsWith('（') ? '' : s.chat.model });
    imageForm.setFieldsValue({
      provider: s.image.providerKey === 'comfyui' ? 'minimax' : (s.image.providerKey as 'minimax' | 'openai'),
      baseUrl: s.image.baseUrl,
      apiKey: '',
      model: s.image.providerKey === 'comfyui' ? '' : s.image.model,
    });
    comfyForm.setFieldsValue({
      comfyBaseUrl: s.image.comfyBaseUrl ?? '',
      workflowPath: s.image.workflowPath ?? '',
      promptNode: s.image.promptNode ?? '',
      negativeNode: s.image.negativeNode ?? '',
      latentNode: s.image.latentNode ?? '',
      seedNode: s.image.seedNode ?? '',
    });
    videoForm.setFieldsValue({
      provider: s.video.providerKey === 'openai' ? 'openai' : 'minimax',
      baseUrl: s.video.baseUrl,
      apiKey: '',
      model: s.video.providerKey === 'openai' ? s.video.model : '',
    });
  }, [chatForm, imageForm, comfyForm, videoForm]);

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

  /** 保存：scope 对应后端端点；comfy 复用 image scope（后端按字段合并） */
  const save = async (scope: 'chat' | 'image' | 'comfy' | 'video'): Promise<void> => {
    const form = scope === 'chat' ? chatForm : scope === 'image' ? imageForm : scope === 'comfy' ? comfyForm : videoForm;
    let values: Record<string, string>;
    try {
      values = await form.validateFields() as unknown as Record<string, string>;
    } catch {
      return;
    }
    setSaving(scope);
    try {
      const endpoint = scope === 'comfy' ? 'image' : scope;
      await api(`/api/admin/model-config/${endpoint}`, { method: 'PUT', body: JSON.stringify(values) });
      message.success('已保存，即时生效（无需重启）');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const runTest = async (scope: 'chat' | 'image' | 'comfy' | 'video'): Promise<void> => {
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

  const applyPreset = (baseUrl: string, model: string): void => {
    chatForm.setFieldsValue({ baseUrl, model });
    message.success('已填入对话配置表单，补上 API Key 后点「保存配置」');
  };

  const imageProvider = Form.useWatch('provider', imageForm);
  const videoProvider = Form.useWatch('provider', videoForm);

  const actionButtons = (opts: { saveScope: 'chat' | 'image' | 'comfy' | 'video'; testScope: 'chat' | 'image' | 'comfy' | 'video'; resetScope?: 'chat' | 'image' | 'video'; resetLabel: string; showReset: boolean }): ReactNode => (
    <Space wrap style={{ marginTop: 4 }}>
      <Button type="primary" icon={<SaveOutlined />} loading={saving === opts.saveScope} onClick={() => void save(opts.saveScope)} style={{ background: BRAND_GRADIENT, border: 'none' }}>
        保存配置
      </Button>
      <Button icon={<ReloadOutlined />} loading={testing === opts.testScope} onClick={() => void runTest(opts.testScope)}>
        连通性测试
      </Button>
      {opts.showReset && opts.resetScope ? (
        <Button danger type="text" icon={<DeleteOutlined />} onClick={() => resetScope(opts.resetScope as 'chat' | 'image' | 'video', opts.resetLabel)}>
          恢复 .env 默认
        </Button>
      ) : null}
    </Space>
  );

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', paddingBottom: 32 }}>
      <PageHeader
        title="模型配置"
        description="在线配置对话 / 生图 / ComfyUI / 生视频的大模型：支持国内外云端 API 与本地模型（Ollama / LM Studio / vLLM / ComfyUI / Sora）。保存即生效，配置持久化到数据库并优先于 .env。"
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
            {actionButtons({ saveScope: 'chat', testScope: 'chat', resetScope: 'chat', resetLabel: '对话', showReset: status.chat.source === 'db' })}
            <TestAlert result={results.chat} />
          </Card>

          {/* —— 生图 —— */}
          <Card
            title={<Space><PictureOutlined style={{ color: '#5B5BF0' }} />生图服务</Space>}
            extra={<StatusTag view={status.image} />}
            styles={{ body: { padding: 18 } }}
          >
            <Form form={imageForm} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 4 } : undefined} wrapperCol={isWide ? { span: 20 } : undefined}>
              <Form.Item name="provider" label="Provider" rules={[{ required: true }]} extra="选 ComfyUI 时请在下方「ComfyUI 本地生图」卡片配置地址与工作流">
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="minimax">MiniMax（云端）</Radio.Button>
                  <Radio.Button value="openai">OpenAI 兼容</Radio.Button>
                  <Radio.Button value="comfyui">ComfyUI（本地）</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {imageProvider === 'comfyui' ? (
                <Alert type="success" showIcon style={{ marginBottom: 12 }} message="已选择 ComfyUI 本地生图，连接参数见下方独立卡片；保存本卡即切换出图后端为 ComfyUI。" />
              ) : (
                <>
                  <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请填写 Base URL' }, { pattern: /^https?:\/\/.+/, message: '需以 http:// 开头' }]}>
                    <Input placeholder={imageProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.minimaxi.com/v1'} allowClear />
                  </Form.Item>
                  <Form.Item name="apiKey" label="API Key" extra={status.image.keyConfigured && status.image.providerKey !== 'comfyui' ? `已保存（${status.image.keyMasked}），留空则保持不变` : undefined}>
                    <Input.Password placeholder="sk-…" autoComplete="off" allowClear />
                  </Form.Item>
                  <Form.Item name="model" label="模型">
                    <Input placeholder={imageProvider === 'openai' ? 'gpt-image-1' : 'image-01'} allowClear />
                  </Form.Item>
                </>
              )}
            </Form>
            {actionButtons({ saveScope: 'image', testScope: 'image', resetScope: 'image', resetLabel: '生图', showReset: status.image.source === 'db' })}
            <TestAlert result={results.image} />
          </Card>

          {/* —— ComfyUI 本地生图（常驻可见） —— */}
          <Card
            title={<Space><DesktopOutlined style={{ color: '#5B5BF0' }} />ComfyUI 本地生图（工作流配置）</Space>}
            styles={{ body: { padding: 18 } }}
          >
            <Text type="secondary">本机启动 ComfyUI 后，在此填写地址与工作流；把上方「生图服务」Provider 选为 ComfyUI 即启用。项目已内置 SD1.5 模板 comfyui-workflow.json，可直接用。</Text>
            <Divider style={{ margin: '12px 0' }} />
            <Form form={comfyForm} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 4 } : undefined} wrapperCol={isWide ? { span: 20 } : undefined}>
              <Form.Item name="comfyBaseUrl" label="ComfyUI 地址" rules={[{ pattern: /^https?:\/\/.+/, message: '需以 http:// 开头' }]} extra="本机默认 http://127.0.0.1:8188">
                <Input placeholder="http://127.0.0.1:8188" allowClear />
              </Form.Item>
              <Form.Item name="workflowPath" label="工作流 JSON" extra="ComfyUI「Workflow → Export (API)」导出的文件路径（相对 api 进程工作目录）">
                <Input placeholder="./comfyui-workflow.json" allowClear />
              </Form.Item>
              <Row gutter={12}>
                {(['promptNode', 'negativeNode', 'latentNode', 'seedNode'] as const).map((node, i) => (
                  <Col span={isWide ? 6 : 12} key={node}>
                    <Form.Item name={node} label={['正向节点', '负向节点', '尺寸节点', '种子节点'][i]}>
                      <Input placeholder={['6', '7', '5', '3'][i]} allowClear />
                    </Form.Item>
                  </Col>
                ))}
              </Row>
            </Form>
            {actionButtons({ saveScope: 'comfy', testScope: 'comfy', resetScope: 'image', resetLabel: 'ComfyUI', showReset: status.image.source === 'db' })}
            <TestAlert result={results.comfy} />
          </Card>

          {/* —— 生视频 —— */}
          <Card
            title={<Space><VideoCameraOutlined style={{ color: '#5B5BF0' }} />生视频服务（{status.video.provider}）</Space>}
            extra={<StatusTag view={status.video} />}
            styles={{ body: { padding: 18 } }}
          >
            <Form form={videoForm} layout={isWide ? 'horizontal' : 'vertical'} labelCol={isWide ? { span: 4 } : undefined} wrapperCol={isWide ? { span: 20 } : undefined}>
              <Form.Item name="provider" label="Provider" rules={[{ required: true }]} extra="MiniMax Director（T2V/I2V，支持首帧图生视频）或 OpenAI Sora 2（videos API）">
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="minimax">MiniMax Director</Radio.Button>
                  <Radio.Button value="openai">OpenAI Sora</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请填写 Base URL' }, { pattern: /^https?:\/\/.+/, message: '需以 http:// 开头' }]}>
                <Input placeholder={videoProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.minimaxi.com/v1'} allowClear />
              </Form.Item>
              <Form.Item name="apiKey" label="API Key" extra={status.video.keyConfigured ? `已保存（${status.video.keyMasked}），留空则保持不变` : videoProvider === 'openai' ? 'OpenAI 平台的 API Key' : 'MiniMax 平台 Key，可与对话共用'}>
                <Input.Password placeholder="sk-…" autoComplete="off" allowClear />
              </Form.Item>
              <Form.Item name="model" label="模型" extra={videoProvider === 'openai' ? 'Sora 模型名，如 sora-2' : '留空即用 T2V/I2V-01-Director（按有无首帧自动切换）'}>
                <Input placeholder={videoProvider === 'openai' ? 'sora-2' : ''} allowClear />
              </Form.Item>
            </Form>
            {actionButtons({ saveScope: 'video', testScope: 'video', resetScope: 'video', resetLabel: '生视频', showReset: status.video.source === 'db' })}
            <TestAlert result={results.video} />
          </Card>

          {/* —— 接入指南 —— */}
          <Card title="接入指南" styles={{ body: { paddingTop: 8 } }}>
            <Tabs
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
                        { key: '1', label: 'ComfyUI（本地生图）', children: '① 本机安装启动 ComfyUI（默认 http://127.0.0.1:8188）→ ② 搭好工作流，菜单 Workflow → Export (API) 导出 JSON → ③ 存为 comfyui-workflow.json → ④ 在上方「ComfyUI 本地生图」卡填地址与工作流并保存，再把「生图服务」Provider 选 ComfyUI。项目已内置一份 SD1.5 模板可直接用。' },
                        { key: '2', label: 'OpenAI Sora（本地/云生视频）', children: '生视频 Provider 选 OpenAI Sora，Base URL 填 https://api.openai.com/v1（或兼容网关），Key 填 OpenAI 平台 Key，模型填 sora-2，保存即可。' },
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
              title="当前生效配置"
              items={[
                { key: 'c', label: '对话', children: `${status.chat.provider} · ${status.chat.baseUrl}` },
                { key: 'i', label: '生图', children: `${status.image.provider} · ${status.image.providerKey === 'comfyui' ? (status.image.comfyBaseUrl ?? '') : status.image.baseUrl}` },
                { key: 'v', label: '生视频', children: `${status.video.provider} · ${status.video.baseUrl}` },
              ]}
            />
          </Card>
        </Space>
      ) : null}
    </div>
  );
}
