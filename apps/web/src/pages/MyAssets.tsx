import { PictureOutlined, PlayCircleOutlined, FileTextOutlined, FilePptOutlined } from '@ant-design/icons';
import { Empty, Grid, Typography, theme } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { useChatStore } from '../store/ChatStore';

const { Text, Title } = Typography;

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'plan', label: '方案' },
  { key: 'copy', label: '文案' },
];

interface Asset {
  id: string;
  kind: 'image' | 'video' | 'plan' | 'copy';
  title: string;
  date: string;
  url?: string;
}

interface MediaRow {
  id: string;
  kind: string;
  title: string;
  filePath: string;
  status: string;
  createdAt: string;
}

const KIND_ICON = {
  image: <PictureOutlined />,
  video: <PlayCircleOutlined />,
  plan: <FilePptOutlined />,
  copy: <FileTextOutlined />,
};

const KIND_LABEL = { image: '图片', video: '视频', plan: '方案', copy: '文案' };

function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

export function MyAssets(): ReactNode {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const { conversations } = useChatStore();
  const [tab, setTab] = useState('all');
  const [media, setMedia] = useState<MediaRow[]>([]);
  // 文件缺失/过期的资产 id（img/video onError 记录），降级为占位态
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const markUnavailable = (id: string): void =>
    setUnavailable((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  useEffect(() => {
    api<MediaRow[]>('/api/media/assets')
      .then(setMedia)
      .catch(() => setMedia([]));
  }, []);

  // 图片/视频来自后端产物库；文案仍从本地对话派生
  const assets = useMemo<Asset[]>(() => {
    const gen: Asset[] = media
      .filter((m) => m.status === 'ready' && (m.kind === 'image' || m.kind === 'video'))
      .map((m) => ({
        id: m.id,
        kind: m.kind === 'video' ? 'video' : 'image',
        title: m.title,
        date: dayKey(new Date(m.createdAt).getTime()),
        url: fileUrl(`/api/media/assets/${m.id}/file`),
      }));
    const derived: Asset[] = conversations
      .filter((c) => c.messages.some((m) => m.role === 'assistant'))
      .map((c) => ({
        id: c.key,
        kind: 'copy' as const,
        title: c.label,
        date: dayKey(c.updatedAt),
      }));
    return [...gen, ...derived];
  }, [media, conversations]);

  const visible = tab === 'all' ? assets : assets.filter((a) => a.kind === tab);

  const grouped = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of visible) {
      const arr = map.get(a.date) ?? [];
      arr.push(a);
      map.set(a.date, arr);
    }
    return [...map.entries()].sort((x, y) => y[0].localeCompare(x[0]));
  }, [visible]);

  return (
    <div style={{ width: '100%', paddingBottom: 24 }}>
      <Title level={3} style={{ marginBottom: 4 }}>我的资料库</Title>
      <Text type="secondary">你生成的图片、视频、方案都保存在这里，随时查看与下载</Text>

      <div style={{ display: 'flex', gap: 8, margin: '18px 0 20px', flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <span
              key={t.key}
              role="button"
              tabIndex={0}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => e.key === 'Enter' && setTab(t.key)}
              style={{
                padding: '6px 16px',
                borderRadius: 9999,
                fontSize: 14,
                cursor: 'pointer',
                userSelect: 'none',
                fontWeight: active ? 600 : 400,
                background: active ? token.colorPrimaryBg : token.colorFillQuaternary,
                color: active ? token.colorPrimary : token.colorTextSecondary,
                border: `1px solid ${active ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
              }}
            >
              {t.label}
            </span>
          );
        })}
      </div>

      {grouped.length === 0 ? (
        <Empty
          description={
            <Text type="secondary">还没有作品，去「AI 生图 / AI 生视频」生成一条，或在工作台对话后回来查看</Text>
          }
          style={{ marginTop: 64 }}
        />
      ) : (
        grouped.map(([date, items]) => (
          <div key={date} style={{ marginBottom: 24 }}>
            <Text strong style={{ display: 'block', fontSize: 13, color: token.colorTextSecondary, marginBottom: 10 }}>
              {date}
            </Text>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${screens.sm ? 200 : 140}px, 1fr))`,
                gap: 14,
              }}
            >
              {items.map((a) => (
                <div
                  key={a.id}
                  style={{
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 12,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: 120,
                      background: unavailable.has(a.id) ? token.colorFillQuaternary : token.colorPrimaryBg,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      fontSize: 26,
                      color: unavailable.has(a.id) ? token.colorTextQuaternary : token.colorPrimary,
                      overflow: 'hidden',
                    }}
                  >
                    {unavailable.has(a.id) ? (
                      <>
                        <PictureOutlined style={{ fontSize: 22 }} />
                        <Text type="secondary" style={{ fontSize: 11 }}>原文件暂不可用</Text>
                      </>
                    ) : a.url && a.kind === 'image' ? (
                      <img src={a.url} alt={a.title} onError={() => markUnavailable(a.id)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : a.url && a.kind === 'video' ? (
                      <video src={a.url} muted playsInline preload="metadata" onError={() => markUnavailable(a.id)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      KIND_ICON[a.kind]
                    )}
                  </div>
                  <div style={{ padding: '8px 10px' }}>
                    <Text style={{ fontSize: 13, display: 'block' }} ellipsis={{ tooltip: a.title }}>
                      {a.title}
                    </Text>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>{KIND_LABEL[a.kind]}</Text>
                      {a.url ? (
                        <a href={a.url} download={a.title} style={{ fontSize: 11 }}>下载</a>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
