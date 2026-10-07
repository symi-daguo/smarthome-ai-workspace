import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Form, Input, Select, Space, Spin, Typography } from 'antd';
import { api } from '../lib/api';
import { useAuth } from '../store/AuthContext';
import { PageHeader } from '../components/PageHeader';

const { Paragraph, Text } = Typography;

interface TestResponse {
  reply: string;
  model: string;
  latencyMs: number;
}

const MODELS = [
  { value: 'MiniMax-M3', label: 'MiniMax-M3（默认）' },
  { value: 'MiniMax-Text-01', label: 'MiniMax-Text-01' },
  { value: 'MiniMax-M2', label: 'MiniMax-M2' },
];

const DEFAULT_SYSTEM = '你是一名简洁的助手，用中文回答，单段不超过 80 字。';

export function ModelTest(): ReactNode {
  const { user } = useAuth();
  const isSuperAdmin = user?.memberships.some((m) =>
    m.permissions.includes('platform:billing:manage'),
  );

  const [form] = Form.useForm<{ model: string; prompt: string; systemPrompt?: string }>();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isSuperAdmin) {
    return (
      <Card>
        <Alert
          type="warning"
          showIcon
          message="无权访问"
          description="仅 super_admin 角色可使用模型测试入口。"
        />
      </Card>
    );
  }

  const onFinish = async (values: { model: string; prompt: string; systemPrompt?: string }) => {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await api<TestResponse>('/api/admin/llm/test', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setResult(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <PageHeader
        title="模型连通测试"
        description="直连 MiniMax OpenAI 兼容端点，验证环境变量中的 API Key 是否生效；0.2.0 将切换为 LiteLLM 网关调用"
      />

      <Card>
        <Form
          form={form}
          layout="vertical"
          onFinish={onFinish}
          initialValues={{ model: MODELS[0].value, systemPrompt: DEFAULT_SYSTEM }}
        >
          <Form.Item name="model" label="模型" rules={[{ required: true }]}>
            <Select options={MODELS} />
          </Form.Item>
          <Form.Item name="systemPrompt" label="系统提示（可选）">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.Item
            name="prompt"
            label="用户输入"
            rules={[{ required: true, message: '请输入测试 prompt' }]}
          >
            <Input.TextArea rows={3} maxLength={2000} placeholder="例如：用一句话介绍智能家居 SaaS 的 token 计费模型。" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>
                发送
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      {error ? (
        <Alert
          type="error"
          showIcon
          message="调用失败"
          description={error}
          style={{ marginTop: 16 }}
        />
      ) : null}

      {result ? (
        <Card style={{ marginTop: 16 }} title="模型回复">
          <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>{result.reply}</Paragraph>
          <Text type="secondary">
            model={result.model} · latency={result.latencyMs}ms
          </Text>
        </Card>
      ) : null}

      {loading ? (
        <Card style={{ marginTop: 16 }}>
          <Space>
            <Spin /> 等待模型响应...
          </Space>
        </Card>
      ) : null}
    </div>
  );
}
