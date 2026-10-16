import {
  BookOutlined, DeleteOutlined, InboxOutlined, SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert, App as AntApp, Button, Card, Empty, Input, List, Popconfirm,
  Space, Spin, Switch, Tag, Tooltip, Typography, Upload, theme,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

interface KbDoc {
  id: string;
  title: string;
  fileName: string;
  fileType: string;
  chars: number;
  enabled: boolean;
  createdAt: string;
}
interface KbList {
  docs: KbDoc[];
  activeChars: number;
  totalChars: number;
}
interface KbHit { title: string; content: string; score: number }

const fmtChars = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`);

/**
 * 本地资料库（零配置 AI 召回）
 *
 * 与外部引擎（WeKnora/Obsidian）并列而非替代：外部召回更强但要自己部署，
 * 这里什么都不用装，上传就生效——这是开源版给伙伴的兜底。
 *
 * 刻意带一个「召回预览」：传完资料能立刻搜一下确认 AI 查得到，
 * 否则用户根本不知道"没生效"和"资料里没写"有什么区别。
 */
export function LocalKnowledgePanel(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [data, setData] = useState<KbList>({ docs: [], activeChars: 0, totalChars: 0 });
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api<KbList>('/api/knowledge/docs'));
    } catch {
      setData({ docs: [], activeChars: 0, totalChars: 0 });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api<{ title: string; chars: number; truncated: boolean }>(
        '/api/knowledge/docs/upload', { method: 'POST', body: form },
      );
      message.success(
        r.truncated
          ? `已入库「${r.title}」（${fmtChars(r.chars)}，超长已截断）`
          : `已入库「${r.title}」（${fmtChars(r.chars)}）`,
      );
      await load();
    } catch (e) {
      message.error((e as Error).message || '上传解析失败');
    } finally {
      setUploading(false);
    }
  };

  const toggle = async (d: KbDoc, enabled: boolean): Promise<void> => {
    try {
      await api(`/api/knowledge/docs/${d.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
      await load();
    } catch (e) {
      message.error((e as Error).message || '切换失败');
    }
  };

  const remove = async (d: KbDoc): Promise<void> => {
    try {
      await api(`/api/knowledge/docs/${d.id}`, { method: 'DELETE' });
      message.success(`已删除「${d.title}」`);
      await load();
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  const search = async (): Promise<void> => {
    const query = q.trim();
    if (!query) return;
    setSearching(true);
    try {
      setHits(await api<KbHit[]>('/api/knowledge/docs/search', { method: 'POST', body: JSON.stringify({ query }) }));
    } catch (e) {
      message.error((e as Error).message || '检索失败');
    } finally {
      setSearching(false);
    }
  };

  return (
    <Card
      title={<Space><BookOutlined />本地资料库（AI 召回）</Space>}
      style={{ marginBottom: 16 }}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          生效 {fmtChars(data.activeChars)} / 累计 {fmtChars(data.totalChars)}
        </Text>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="上传一次，之后所有 AI 对话、方案、报价都会按需参考这些资料"
        description={
          <>
            支持 TXT / MD / DOCX / XLSX / PDF / HTML，单份最多 8 万字。
            <strong>不需要部署任何东西</strong>就能用；如果你已经在跑 WeKnora / Obsidian，
            外部知识库仍然可用且召回更强，本页是它的零配置兜底。
            同名文件重传会覆盖更新，不会重复入库。
          </>
        }
      />

      <Space wrap style={{ marginBottom: 14 }}>
        <Upload
          accept=".txt,.md,.docx,.xlsx,.pdf,.html,.htm,.csv,.json"
          showUploadList={false}
          beforeUpload={(f) => { void upload(f); return false; }}
        >
          <Button type="primary" icon={<UploadOutlined />} loading={uploading}
            style={{ background: BRAND_GRADIENT, border: 'none' }}>
            上传资料
          </Button>
        </Upload>
        <Input
          style={{ width: 260 }}
          placeholder="搜一下 AI 到底能不能查到…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onPressEnter={() => void search()}
          allowClear
        />
        <Button icon={<SearchOutlined />} loading={searching} onClick={() => void search()}>
          召回预览
        </Button>
      </Space>

      {hits !== null ? (
        <div style={{ marginBottom: 16, padding: 12, background: token.colorFillQuaternary, borderRadius: 10 }}>
          <Text strong style={{ fontSize: 13 }}>
            预览「{q}」：{hits.length ? `命中 ${hits.length} 段` : '没有命中任何资料'}
          </Text>
          {hits.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              没命中通常有两种原因：资料里确实没写，或者这份资料被关掉了（开关在下面）。
            </Text>
          ) : (
            hits.map((h, i) => (
              <div key={i} style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
                <Tag color="blue">{h.title}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>{h.content.slice(0, 160)}{h.content.length > 160 ? '…' : ''}</Text>
              </div>
            ))
          )}
        </div>
      ) : null}

      {data.docs.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">还没有资料。上传后，AI 写方案 / 报价 / 文案时会自动参考你的内容</Text>}
          style={{ margin: '20px 0' }}
        />
      ) : (
        <List
          dataSource={data.docs}
          loading={loading}
          renderItem={(d) => (
            <List.Item
              actions={[
                <Popconfirm key="del" title="删除这份资料？" description="只删库里的副本与召回索引" okText="删除" cancelText="取消"
                  onConfirm={() => void remove(d)}>
                  <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label={`删除 ${d.title}`} />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={8} wrap>
                    <Text strong>{d.title}</Text>
                    <Tag>{d.fileType || '文档'}</Tag>
                    {!d.enabled ? <Tag color="default">已停用</Tag> : null}
                  </Space>
                }
                description={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {fmtChars(d.chars)} · {d.fileName} · {d.createdAt?.slice(0, 10)}
                  </Text>
                }
              />
              <Tooltip title={d.enabled ? '正在参与 AI 召回' : '已停用，AI 不会参考这份资料'}>
                <Switch size="small" checked={d.enabled} onChange={(v) => void toggle(d, v)} />
              </Tooltip>
            </List.Item>
          )}
        />
      )}

      {uploading ? (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <Spin tip="解析中…"><InboxOutlined style={{ fontSize: 20, padding: 12 }} /></Spin>
        </div>
      ) : null}
    </Card>
  );
}
