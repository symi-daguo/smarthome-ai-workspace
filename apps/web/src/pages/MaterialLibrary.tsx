import { PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Empty, Image, Input, Modal, Space, Tabs, Tag, Typography, Upload, theme } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { INK_BLACK, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

/** 投稿审核状态 */
const SUB_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: '待审核', color: 'orange' },
  approved: { label: '已通过并上架', color: 'green' },
  rejected: { label: '未通过', color: 'red' },
  offline: { label: '已下架', color: 'default' },
};

interface Submission {
  id: string;
  title: string;
  desc: string;
  status: string;
  reviewNote: string;
  createdAt: string;
}

interface Material {
  key: string;
  title: string;
  desc: string;
  brand: string;
  downloads: number;
  img: string;
}

const EXCELLENT: Material[] = [
  { key: 'm1', title: '客厅灯光 窗帘展示效果', desc: '适合客厅灯光 窗帘展示效果', brand: '品牌', downloads: 0, img: '/images/materials/m1.jpg' },
  { key: 'm2', title: '客厅的灯光秀展示', desc: '餐厅灯光场景切换演示', brand: '演示门店', downloads: 1, img: '/images/materials/m2.jpg' },
];

function MaterialCard({ m, owned, onBuy, onPreview }: { m: Material; owned: boolean; onBuy: (key: string) => void; onPreview: (m: Material) => void }): ReactNode {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 165,
          background: `url(${m.img}) center/cover no-repeat`,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Tag style={{ position: 'absolute', top: 10, left: 10, borderRadius: 6 }}>AI 生视频</Tag>
        <PlayCircleOutlined style={{ fontSize: 42, color: 'rgba(255,255,255,0.85)' }} />
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <Text strong style={{ display: 'block', fontSize: 14 }}>{m.title}</Text>
        <Text type="secondary" style={{ fontSize: 12.5, display: 'block', margin: '3px 0 8px' }}>{m.desc}</Text>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: token.colorTextTertiary, marginBottom: 10 }}>
          <span>{m.brand}</span>
          <span>下载 {m.downloads}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* 应用内预览弹窗（可关闭返回），不再 window.open 跳独立页面导致无法返回 */}
          <Button block size="small" style={{ borderRadius: 8 }} onClick={() => onPreview(m)}>
            查看素材
          </Button>
          {owned ? (
            <Button block size="small" style={{ borderRadius: 8 }} href={m.img} download>
              下载原图
            </Button>
          ) : (
            <Button
              block
              size="small"
              onClick={() => onBuy(m.key)}
              style={{
                borderRadius: 8,
                background: INK_BLACK,
                color: '#fff',
                border: 'none',
              }}
            >
              下载 1 元
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface MediaRow {
  kind: string;
  title: string;
}

export function MaterialLibrary(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [tab, setTab] = useState('excellent');
  const [ownedKeys, setOwnedKeys] = useState<string[]>([]);
  const [preview, setPreview] = useState<Material | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [uploadAsset, setUploadAsset] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadSubmissions = async (): Promise<void> => {
    try {
      setSubmissions(await api<Submission[]>('/api/media/materials/submissions'));
    } catch {
      setSubmissions([]);
    }
  };

  useEffect(() => {
    void loadSubmissions();
  }, []);

  const submit = async (): Promise<void> => {
    if (!uploadAsset || !title.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/media/materials/submissions', {
        method: 'POST',
        body: JSON.stringify({ assetId: uploadAsset, title: title.trim(), desc: desc.trim() }),
      });
      message.success('投稿已提交，审核结果会在这里更新');
      setUploadAsset('');
      setUploadName('');
      setTitle('');
      setDesc('');
      await loadSubmissions();
      setTab('mine');
    } catch (e) {
      message.error((e as Error).message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    api<MediaRow[]>('/api/media/assets')
      .then((rows) => setOwnedKeys(rows.filter((r) => r.kind === 'material').map((r) => r.title)))
      .catch(() => setOwnedKeys([]));
  }, []);

  const buy = async (key: string): Promise<void> => {
    try {
      await api('/api/media/materials/purchase', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      setOwnedKeys((prev) => [...prev, key]);
      message.success('购买成功，已扣 1 元额度，可直接下载原图');
    } catch (e) {
      message.error((e as Error).message || '购买失败');
    }
  };

  return (
    <div style={pageContainerStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <Title level={3} style={{ marginBottom: 4 }}>视频素材库</Title>
          <Text type="secondary">发现同行的优秀视频作品。首次购买支付 1 元额度，即可下载对应原图和完整视频。</Text>
        </div>
        <Card
          size="small"
          style={{ background: token.colorPrimaryBg, border: 'none', maxWidth: 280 }}
          styles={{ body: { padding: '10px 14px' } }}
        >
          <Text strong style={{ color: token.colorPrimary, fontSize: 13 }}>创作者收益</Text>
          <Text style={{ display: 'block', fontSize: 12.5 }}>审核发布奖 5 元 · 不同公司首次购买再得 1 元</Text>
        </Card>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'excellent', label: '优秀素材' },
          { key: 'mine', label: '我的投稿' },
          { key: 'bought', label: `已购买${ownedKeys.length > 0 ? `（${ownedKeys.length}）` : ''}` },
        ]}
      />

      {tab === 'excellent' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginTop: 8 }}>
          {EXCELLENT.map((m) => (
            <MaterialCard key={m.key} m={m} owned={ownedKeys.includes(m.key)} onBuy={buy} onPreview={setPreview} />
          ))}
        </div>
      ) : tab === 'bought' ? (
        ownedKeys.length === 0 ? (
          <Empty description="还没有购买记录，在「优秀素材」下载 1 元即可购买" style={{ marginTop: 48 }} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginTop: 8 }}>
            {EXCELLENT.filter((m) => ownedKeys.includes(m.key)).map((m) => (
              <MaterialCard key={m.key} m={m} owned onBuy={buy} onPreview={setPreview} />
            ))}
          </div>
        )
      ) : (
        <div style={{ marginTop: 8 }}>
          <Card size="small" style={{ marginBottom: 16, background: token.colorFillQuaternary, border: 'none' }}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                上传你的原创视频投稿，审核通过后会进入「优秀素材」供同行下载。
                投稿免费；审核通过发布奖 5 元，不同公司首次购买再得 1 元。
              </Text>
              <Space wrap>
                <Upload
                  accept="video/mp4,video/webm,video/quicktime"
                  showUploadList={false}
                  beforeUpload={async (f) => {
                    setUploading(true);
                    try {
                      const fd = new FormData();
                      fd.append('file', f);
                      const r = await api<{ id: string }>('/api/media/materials/upload', { method: 'POST', body: fd });
                      setUploadAsset(r.id);
                      setUploadName(f.name);
                      message.success('文件已上传，填完标题即可提交审核');
                    } catch (e) {
                      message.error((e as Error).message || '上传失败');
                    } finally {
                      setUploading(false);
                    }
                    return false;
                  }}
                >
                  <Button icon={<PlusOutlined />} loading={uploading}>
                    {uploadAsset ? '重新选择视频' : '选择视频文件'}
                  </Button>
                </Upload>
                {uploadAsset && <Tag color="blue">已选：{uploadName}</Tag>}
              </Space>
              {uploadAsset && (
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    placeholder="给素材起个标题，例如：全屋智能灯光交付实拍"
                    maxLength={60}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <Button type="primary" loading={submitting} disabled={!title.trim()} onClick={() => void submit()}>
                    提交审核
                  </Button>
                </Space.Compact>
              )}
              {uploadAsset && (
                <Input.TextArea
                  placeholder="一句话说明这条素材的看点（可选，500 字内）"
                  maxLength={500}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                />
              )}
            </Space>
          </Card>

          {submissions.length === 0 ? (
            <Empty description="还没有投稿记录，选一个视频文件就能开始" style={{ padding: '32px 0' }} />
          ) : (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {submissions.map((s) => (
                <Card key={s.id} size="small">
                  <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                    <Space direction="vertical" size={2}>
                      <Text strong>{s.title}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(s.createdAt).toLocaleString('zh-CN')}
                        {s.desc ? ` · ${s.desc}` : ''}
                      </Text>
                      {s.reviewNote && (
                        <Text type={s.status === 'rejected' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                          审核意见：{s.reviewNote}
                        </Text>
                      )}
                    </Space>
                    <Tag color={SUB_STATUS[s.status]?.color ?? 'default'}>{SUB_STATUS[s.status]?.label ?? s.status}</Tag>
                  </Space>
                </Card>
              ))}
            </Space>
          )}
        </div>
      )}

      {/* 应用内素材预览：关闭即回到列表，不离开当前页 */}
      <Modal
        title={preview ? `素材预览 · ${preview.title}` : ''}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={
          preview ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <Text type="secondary" style={{ fontSize: 12, alignSelf: 'center' }}>{preview.desc}</Text>
              <Button type="primary" onClick={() => setPreview(null)}>返回素材库</Button>
            </div>
          ) : null
        }
        width={720}
        destroyOnHidden
      >
        {preview ? (
          <Image
            src={preview.img}
            alt={preview.title}
            style={{ width: '100%', borderRadius: 12, maxHeight: 480, objectFit: 'cover' }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
