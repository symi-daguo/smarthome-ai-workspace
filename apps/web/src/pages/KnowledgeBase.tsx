import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, List, Switch, Typography, Upload, theme } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { BRAND_GRADIENT } from '../theme/tokens';

const { Text, Title } = Typography;

interface DocItem {
  id: string;
  title: string;
  docType: string;
  updatedAt: string;
  job: { source: string; sourceRef: string | null; score: number | null };
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
    <div style={{ paddingBottom: 24 }}>
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
