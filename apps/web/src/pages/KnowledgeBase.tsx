import { DeleteOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  List,
  Radio,
  Space,
  Switch,
  Tag,
  Typography,
  Upload,
  theme,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

interface DocItem {
  id: string;
  title: string;
  docType: string;
  updatedAt: string;
  job: { source: string; sourceRef: string | null; score: number | null };
}

interface ExternalStatus {
  provider: 'none' | 'weknora' | 'obsidian';
  baseUrl: string;
  kbIds: string;
  enabled: boolean;
  source: 'db' | 'env';
  keyConfigured: boolean;
  keyMasked: string | null;
}

interface ExternalForm {
  provider: 'none' | 'weknora' | 'obsidian';
  baseUrl: string;
  apiKey: string;
  kbIds: string;
}

interface Chunk {
  title: string;
  content: string;
  score: number;
  source: string;
}

/** 外部知识库（客户本机部署 WeKnora / Obsidian，平台经 REST 检索联动各板块 agent） */
function ExternalKnowledgeCard(): ReactNode {
  const { message } = AntApp.useApp();
  const [status, setStatus] = useState<ExternalStatus | null>(null);
  const [form, setForm] = useState<ExternalForm>({ provider: 'none', baseUrl: '', apiKey: '', kbIds: '' });
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [chunks, setChunks] = useState<Chunk[] | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const s = await api<ExternalStatus>('/api/knowledge/external');
    setStatus(s);
    setForm({ provider: s.provider, baseUrl: s.baseUrl, apiKey: '', kbIds: s.kbIds });
    setEnabled(s.enabled);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api('/api/knowledge/external', { method: 'PUT', body: JSON.stringify({ ...form, enabled: enabled ? 'true' : 'false' }) });
      message.success('已保存，即时生效（无需重启）');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const resetToEnv = async (): Promise<void> => {
    try {
      await api('/api/knowledge/external', { method: 'DELETE' });
      message.success('已恢复 .env 默认');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api<{ ok: boolean; detail?: string; error?: string }>('/api/knowledge/external/test', { method: 'POST' }));
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const search = async (): Promise<void> => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setChunks(null);
    try {
      const r = await api<{ chunks: Chunk[] }>('/api/knowledge/external/search', { method: 'POST', body: JSON.stringify({ query: searchQuery }) });
      setChunks(r.chunks);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  if (!status) return null;

  return (
    <Card
      style={{ marginTop: 20 }}
      styles={{ body: { padding: 20 } }}
      title={<Space><RobotOutlined style={{ color: '#5B5BF0' }} />外部知识库联动（WeKnora / Obsidian）</Space>}
      extra={
        <Space>
          <Switch checked={enabled} onChange={setEnabled} />
          <Text strong style={{ fontSize: 13 }}>启用</Text>
          <Tag color={status.source === 'db' ? 'blue' : 'default'}>{status.source === 'db' ? '在线配置生效' : '.env 默认'}</Tag>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="客户电脑性能足够时，可自行部署专业知识库引擎，平台通过 REST 接口实时检索，让对话 / 接单 / 方案生成等所有板块的 AI 优先参考你的资料。"
        description={
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12.5 }}>
            <li><b>WeKnora</b>（腾讯开源，GitHub: Tencent/WeKnora）：git clone 后 docker compose up -d，默认后端 http://127.0.0.1:8080，在 WeKnora 网页「账户设置」创建 API Key 填入此处</li>
            <li><b>Obsidian</b>：安装社区插件「Local REST API with MCP」并启用，默认 http://127.0.0.1:27124（insecure HTTP 为 27123），插件设置里复制 API Key 填入此处</li>
          </ul>
        }
      />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap size={12}>
          <Radio.Group
            value={form.provider}
            onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value, baseUrl: e.target.value === 'obsidian' ? 'http://127.0.0.1:27124' : e.target.value === 'weknora' ? 'http://127.0.0.1:8080/api/v1' : '' }))}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="none">不使用</Radio.Button>
            <Radio.Button value="weknora">WeKnora</Radio.Button>
            <Radio.Button value="obsidian">Obsidian</Radio.Button>
          </Radio.Group>
          {form.provider !== 'none' ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前：{status.provider === 'none' ? '未配置' : `${status.provider} · ${status.baseUrl}`}{status.keyConfigured ? ` · Key ${status.keyMasked}` : ''}
            </Text>
          ) : null}
        </Space>
        {form.provider !== 'none' ? (
          <>
            <Space.Compact block>
              <Input style={{ flex: 2 }} placeholder="服务地址，如 http://127.0.0.1:8080/api/v1" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} />
              <Input.Password style={{ flex: 1 }} placeholder={status.keyConfigured ? `已保存 ${status.keyMasked}，留空不变` : 'API Key'} value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} autoComplete="off" />
            </Space.Compact>
            {form.provider === 'weknora' ? (
              <Input placeholder="限定知识库 id（逗号分隔，留空=检索全部）" value={form.kbIds} onChange={(e) => setForm((f) => ({ ...f, kbIds: e.target.value }))} />
            ) : null}
            <Space wrap>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()} style={{ background: BRAND_GRADIENT, border: 'none' }}>保存配置</Button>
              <Button icon={<ReloadOutlined />} loading={testing} onClick={() => void test()}>连通性测试</Button>
            </Space>
            {testResult ? (
              testResult.ok
                ? <Alert type="success" showIcon message={`连接正常 · ${testResult.detail ?? ''}`} />
                : <Alert type="error" showIcon message="连接失败" description={testResult.error} />
            ) : null}
            <Space.Compact block>
              <Input placeholder="检索演示：输入关键词看命中片段（如「窗帘电机」）" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onPressEnter={() => void search()} />
              <Button loading={searching} onClick={() => void search()}>检索</Button>
            </Space.Compact>
            {chunks ? (
              chunks.length === 0
                ? <Text type="secondary" style={{ fontSize: 12 }}>无命中片段（若上方「启用」开关未打开，请先启用并保存；否则确认关键词存在于外部库）</Text>
                : (
                  <List
                    size="small"
                    dataSource={chunks}
                    renderItem={(c) => (
                      <List.Item>
                        <div style={{ width: '100%' }}>
                          <Space><Tag color="purple">{c.source}</Tag><Text strong style={{ fontSize: 13 }}>{c.title}</Text></Space>
                          <div><Text type="secondary" style={{ fontSize: 12 }}>{c.content.slice(0, 160)}…</Text></div>
                        </div>
                      </List.Item>
                    )}
                  />
                )
            ) : null}
          </>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>选择 WeKnora 或 Obsidian 后填写地址与 Key 即可联动，未启用时各板块 AI 仅使用上方「已入库资料」。</Text>
            {status.provider !== 'none' || status.source === 'db' ? (
              <Space wrap>
                <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()} style={{ background: BRAND_GRADIENT, border: 'none' }}>保存（关闭联动）</Button>
                <Button danger type="text" icon={<DeleteOutlined />} onClick={() => void resetToEnv()}>恢复 .env 默认</Button>
              </Space>
            ) : null}
          </Space>
        )}
      </Space>
    </Card>
  );
}

export function KnowledgeBase(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [enabled, setEnabled] = useState(true);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api<DocItem[]>('/api/content/extractions/documents')
      .then(setDocs)
      .catch(() => setDocs([]));
  }, []);

  const uploadAll = async (): Promise<void> => {
    if (files.length === 0) return;
    setUploading(true);
    let ok = 0;
    for (const f of files) {
      try {
        const form = new FormData();
        form.append('file', f);
        form.append('docType', 'general');
        await api('/api/content/extractions/upload', { method: 'POST', body: form });
        ok += 1;
      } catch {
        message.error(`${f.name} 解析失败`);
      }
    }
    setUploading(false);
    setFiles([]);
    if (ok > 0) {
      message.success(`${ok} 份资料已进入提取队列，确认后将入库`);
      const list = await api<DocItem[]>('/api/content/extractions/documents').catch(() => docs);
      setDocs(list);
    }
  };

  const removeDoc = async (id: string): Promise<void> => {
    try {
      await api(`/api/content/extractions/documents/${id}`, { method: 'DELETE' });
      setDocs((prev) => prev.filter((d) => d.id !== id));
      message.success('已删除');
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  return (
    <div style={pageContainerStyle}>
      <Title level={3} style={{ marginBottom: 4 }}>我的知识库</Title>
      <Text type="secondary">
        上传你的产品资料、报价规则、品牌话术等，之后所有智能体回答都会优先参考你的资料——一次上传，处处生效
      </Text>

      <div
        style={{
          marginTop: 20,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 16,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Switch checked={enabled} onChange={setEnabled} />
          <Text strong>启用知识库</Text>
          <div style={{ flex: 1 }} />
          <Upload
            multiple
            accept=".txt,.md,.doc,.docx,.xls,.xlsx,.pdf,.html"
            showUploadList={false}
            beforeUpload={(f) => {
              setFiles((prev) => [...prev, f]);
              return false;
            }}
          >
            <Button icon={<PlusOutlined />}>选择文件</Button>
          </Upload>
          <Button
            type="primary"
            disabled={files.length === 0}
            loading={uploading}
            onClick={uploadAll}
            style={{ background: BRAND_GRADIENT, border: 'none' }}
          >
            上传入库
          </Button>
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          支持 txt / md / Word / PDF，可多选，单份上限约 8 万字{files.length > 0 ? `；已选 ${files.length} 个文件` : ''}
        </Text>
      </div>

      {enabled ? null : (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message="知识库已停用，智能体回答不会参考以下资料"
        />
      )}

      <ExternalKnowledgeCard />

      <div
        style={{
          marginTop: 20,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 16,
          padding: '8px 20px 20px',
        }}
      >
        <Text strong style={{ display: 'block', margin: '14px 0 6px' }}>已入库资料（{docs.length}）</Text>
        <List
          dataSource={docs}
          locale={{ emptyText: '还没有资料，上传后智能体回答将优先参考' }}
          renderItem={(d) => (
            <List.Item
              actions={[
                <Button key="del" type="text" size="small" icon={<DeleteOutlined />} danger onClick={() => removeDoc(d.id)}>
                  删除
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={<Text strong style={{ fontSize: 14 }}>{d.title}</Text>}
                description={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {d.docType === 'product' ? '产品资料' : d.docType === 'meeting' ? '会议纪要' : '通用文本'} · 质量分 {d.job?.score ?? '-'} · {d.updatedAt?.slice(5, 16).replace('T', ' ')}
                  </Text>
                }
              />
            </List.Item>
          )}
        />
      </div>
    </div>
  );
}
