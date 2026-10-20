import {
  DeleteOutlined,
  EditOutlined,
  FilePptOutlined,
  FileTextOutlined,
  MoreOutlined,
  PictureOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { App as AntApp, Button, Dropdown, Empty, Grid, Modal, Popconfirm, Typography, theme } from 'antd';
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
  const { message } = AntApp.useApp();
  // 重命名 Modal 状态：资产 id + 初始标题
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [renameText, setRenameText] = useState('');
  // 删除确认 Modal：Dropdown item 里嵌 Popconfirm 在 antd v6 下会被外层 outside click 关掉，改用 Modal 二次确认
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    api<MediaRow[]>('/api/media/assets')
      .then(setMedia)
      .catch(() => setMedia([]));
  }, []);

  // 重命名：点卡片「重命名」打开 Modal 改写标题（最基本的修改能力）
  const openRename = (id: string, currentTitle: string): void => {
    setRenaming({ id, title: currentTitle });
    setRenameText(currentTitle);
  };
  const submitRename = async (): Promise<void> => {
    if (!renaming) return;
    const title = renameText.trim();
    if (!title) {
      message.warning('标题不能为空');
      return;
    }
    if (title === renaming.title) {
      setRenaming(null);
      return;
    }
    try {
      await api(`/api/media/assets/${renaming.id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      setMedia((prev) => prev.map((m) => (m.id === renaming.id ? { ...m, title } : m)));
      message.success('已重命名');
      setRenaming(null);
    } catch (e) {
      message.error((e as Error).message || '重命名失败');
    }
  };
  // 删除：DB 行 + 本地文件，公共产品图被引用时后端 400 ASSET_REFUSED_BY_PRODUCT
  const removeAsset = async (id: string, title: string): Promise<void> => {
    try {
      await api(`/api/media/assets/${id}`, { method: 'DELETE' });
      setMedia((prev) => prev.filter((m) => m.id !== id));
      message.success(`已删除「${title}」`);
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

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
      <Title level={3} style={{ marginBottom: 4 }}>我的作品</Title>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {a.url ? (
                          <a href={a.url} download={a.title} style={{ fontSize: 11 }}>下载</a>
                        ) : null}
                        {a.kind === 'image' || a.kind === 'video' ? (
                          <Dropdown
                            trigger={['click']}
                            menu={{
                              items: [
                                {
                                  key: 'rename',
                                  icon: <EditOutlined />,
                                  label: '重命名',
                                  onClick: () => openRename(a.id, a.title),
                                },
                                { type: 'divider' },
                                {
                                  key: 'delete',
                                  icon: <DeleteOutlined />,
                                  danger: true,
                                  label: '删除',
                                  onClick: () => setDeleting({ id: a.id, title: a.title }),
                                },
                              ],
                            }}
                          >
                            <Button type="text" size="small" icon={<MoreOutlined />} aria-label="更多操作" />
                          </Dropdown>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <Modal
        title="重命名"
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        onOk={() => void submitRename()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <input
          autoFocus
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          maxLength={100}
          style={{ width: '100%', padding: '6px 10px', border: '1px solid #d9d9d9', borderRadius: 6, fontSize: 14 }}
          placeholder="给这张图片起个名字"
        />
      </Modal>

      <Modal
        title="删除资料"
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onOk={async () => {
          if (!deleting) return;
          await removeAsset(deleting.id, deleting.title);
          setDeleting(null);
        }}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        确定删除「{deleting?.title}」？文件会一并清理，方案/产品引用中时会被服务端 400 拒绝。
      </Modal>
    </div>
  );
}
