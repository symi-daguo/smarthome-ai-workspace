import { PlayCircleOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Empty, Tabs, Tag, Typography, theme } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { INK_BLACK } from '../theme/tokens';

const { Text, Title } = Typography;

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

function MaterialCard({ m, owned, onBuy }: { m: Material; owned: boolean; onBuy: (key: string) => void }): ReactNode {
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
          <Button block size="small" style={{ borderRadius: 8 }} onClick={() => window.open(m.img, '_blank')}>
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
    <div style={{ paddingBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <Title level={3} style={{ marginBottom: 4 }}>优秀视频素材库</Title>
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
            <MaterialCard key={m.key} m={m} owned={ownedKeys.includes(m.key)} onBuy={buy} />
          ))}
        </div>
      ) : tab === 'bought' ? (
        ownedKeys.length === 0 ? (
          <Empty description="还没有购买记录，在「优秀素材」下载 1 元即可购买" style={{ marginTop: 48 }} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginTop: 8 }}>
            {EXCELLENT.filter((m) => ownedKeys.includes(m.key)).map((m) => (
              <MaterialCard key={m.key} m={m} owned onBuy={buy} />
            ))}
          </div>
        )
      ) : (
        <Empty
          description="还没有投稿，上传你的优秀视频赚取收益（投稿链路 0.3.0 接入）"
          style={{ marginTop: 48 }}
        />
      )}
    </div>
  );
}
