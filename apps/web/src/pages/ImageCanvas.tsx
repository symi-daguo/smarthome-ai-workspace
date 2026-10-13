import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Drawer, Empty, Input, Modal, Segmented, Spin, Tag, Tooltip, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  AppstoreOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api, fileUrl } from '../lib/api';
import { compressImage } from '../lib/compress';
import { PageHeader } from '../components/PageHeader';
import { pageContainerStyle } from '../theme/tokens';

const { Text, Paragraph } = Typography;

/**
 * AI 画布（对话式生图）
 *
 * 与「AI 生图」表单页的分工：那边是一次性出图（选场景/选风格/填参数），这边是
 * 连续迭代创作——多轮对话、每轮可出多个变体、基于任一历史图派生新分支并随时切回。
 *
 * 设计要点（对应 replica/ai-canvas-spec.md）：
 *   1. 变体是「追加」不是「覆盖」：重新生成不会丢上一张
 *   2. 分支是树不是线：‹ 分支 N/M › 可在派生链之间来回切
 *   3. 出图走异步作业 + 轮询，不长时间占住连接
 *   4. 每轮标注「基于哪张图」，来源可追溯
 */

interface Variant {
  url: string;
  label: string;
  createdAt: string;
}

interface Turn {
  id: string;
  parentId: string | null;
  prompt: string;
  kind: 'user' | 'assistant';
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
  variants: Variant[];
  createdAt: string;
  /** 以本轮为父的直接子轮 id（后端随详情一起返回） */
  children: string[];
}

interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount?: number;
  preview?: string;
}

type JobStatus = 'pending' | 'running' | 'done' | 'failed';

const RATIOS = [
  { value: '1536x1024', label: '横图 3:2' },
  { value: '1024x1536', label: '竖图 2:3' },
  { value: '1024x1024', label: '方图 1:1' },
];

export function ImageCanvas(): ReactNode {
  const { message } = AntApp.useApp();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [input, setInput] = useState('');
  const [ratio, setRatio] = useState('1536x1024');
  const [fitVideo, setFitVideo] = useState(false);
  const [refImage, setRefImage] = useState<{ assetId: string; url: string } | null>(null);

  /** 每个父轮当前选中的子分支 */
  const [branchChoice, setBranchChoice] = useState<Record<string, string>>({});
  /** 灯箱：正在查看的轮与变体下标 */
  const [lightbox, setLightbox] = useState<{ turnId: string; index: number } | null>(null);

  const pollRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<TextAreaRef>(null);

  // ---------- 数据 ----------
  const loadConversations = useCallback(async () => {
    try {
      setConversations(await api<Conversation[]>('/api/canvas/conversations'));
    } catch {
      setConversations([]);
    }
  }, []);

  const loadTurns = useCallback(async (cid: string) => {
    setLoading(true);
    try {
      const d = await api<{ turns: Turn[] }>(`/api/canvas/conversations/${cid}`);
      setTurns(d.turns);
      setBranchChoice({});
    } catch (e) {
      setTurns([]);
      message.error((e as Error).message || '加载对话失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // 会话删除后若删的是当前会话，切到列表首个
  useEffect(() => {
    if (activeId && conversations.length && !conversations.some((c) => c.id === activeId)) {
      setActiveId(conversations[0].id);
    }
    if (!activeId && conversations.length) setActiveId(conversations[0].id);
  }, [conversations, activeId]);

  useEffect(() => {
    if (activeId) void loadTurns(activeId);
    else setTurns([]);
  }, [activeId, loadTurns]);

  // ---------- 分支树 ----------
  const byId = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);
  const headTurn = useMemo(() => turns.find((t) => t.parentId === null) ?? null, [turns]);

  /** 从头沿当前选定分支走到叶子；children>1 时按 branchChoice 走 */
  const path = useMemo(() => {
    const out: Turn[] = [];
    let cur: Turn | undefined = headTurn ?? undefined;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.push(cur);
      const kids = cur.children ?? [];
      if (!kids.length) break;
      const pick = branchChoice[cur.id] && kids.includes(branchChoice[cur.id]) ? branchChoice[cur.id] : kids[0];
      cur = byId.get(pick);
    }
    return out;
  }, [headTurn, byId, branchChoice]);

  const switchBranch = useCallback((parentId: string, dir: 1 | -1) => {
    const parent = byId.get(parentId);
    const kids = parent?.children ?? [];
    if (kids.length < 2) return;
    const cur = branchChoice[parentId] ?? kids[0];
    const idx = kids.indexOf(cur);
    const next = kids[(idx + dir + kids.length) % kids.length];
    setBranchChoice((prev) => ({ ...prev, [parentId]: next }));
  }, [byId, branchChoice]);

  // ---------- 出图（异步作业 + 轮询） ----------
  const pollJob = useCallback((cid: string, jobId: string, turnId: string) => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
    const tick = async (): Promise<void> => {
      try {
        const job = await api<{ status: JobStatus }>(`/api/canvas/jobs/${jobId}`);
        if (job.status === 'done' || job.status === 'failed') {
          await loadTurns(cid);
          if (job.status === 'failed') message.error('出图失败，请检查模型配置后重试');
          return;
        }
        pollRef.current = window.setTimeout(() => void tick(), 1500);
      } catch {
        await loadTurns(cid);
      }
    };
    void tick();
  }, [loadTurns, message]);

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (activeId) return activeId;
    const c = await api<Conversation>('/api/canvas/conversations', { method: 'POST', body: JSON.stringify({}) });
    await loadConversations();
    setActiveId(c.id);
    return c.id;
  }, [activeId, loadConversations]);

  const send = useCallback(async (baseTurnId?: string) => {
    const text = input.trim();
    if (text.length < 4) {
      message.warning('多写几个字描述你想要的画面');
      return;
    }
    setSending(true);
    try {
      const cid = await ensureConversation();
      const r = await api<{ turnId: string; jobId: string }>(`/api/canvas/conversations/${cid}/turns`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: text,
          parentId: baseTurnId,
          refAssetId: refImage?.assetId,
          size: ratio,
          fitVideo,
        }),
      });
      setInput('');
      await loadTurns(cid);
      pollJob(cid, r.jobId, r.turnId);
    } catch (e) {
      message.error((e as Error).message || '发送失败');
    } finally {
      setSending(false);
    }
  }, [input, ensureConversation, refImage, ratio, fitVideo, loadTurns, pollJob, message]);

  /** 重新生成：基于同一张基底图再来一版（变体追加，不覆盖） */
  const regenerate = useCallback(async (turn: Turn) => {
    if (sending) return;
    setSending(true);
    try {
      const cid = await ensureConversation();
      // assistant 轮的前一轮是它的基底指令
      const src = turn.parentId ? byId.get(turn.parentId) : undefined;
      const r = await api<{ jobId: string }>(`/api/canvas/conversations/${cid}/turns`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: src?.prompt ?? turn.prompt,
          parentId: src?.parentId ?? undefined,
          size: ratio,
          fitVideo,
        }),
      });
      await loadTurns(cid);
      pollJob(cid, r.jobId, turn.id);
    } catch (e) {
      message.error((e as Error).message || '重新生成失败');
    } finally {
      setSending(false);
    }
  }, [sending, ensureConversation, byId, ratio, fitVideo, loadTurns, pollJob, message]);

  /** 把某轮提示词拉回输入框继续改 */
  const restore = useCallback((t: Turn) => {
    setInput(t.prompt);
    taRef.current?.focus();
    message.info('已把这一轮的描述放回输入框，改完直接发送');
  }, [message]);

  const newConversation = useCallback(async () => {
    try {
      const c = await api<Conversation>('/api/canvas/conversations', { method: 'POST', body: JSON.stringify({}) });
      await loadConversations();
      setActiveId(c.id);
      setInput('');
    } catch (e) {
      message.error((e as Error).message || '新建失败');
    }
  }, [loadConversations, message]);

  const removeConversation = useCallback(async (id: string) => {
    try {
      await api(`/api/canvas/conversations/${id}`, { method: 'DELETE' });
      await loadConversations();
      if (activeId === id) setActiveId('');
      message.success('已删除对话');
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  }, [loadConversations, activeId, message]);

  const uploadRef = useCallback(async (file: File) => {
    try {
      const blob = await compressImage(file);
      const fd = new FormData();
      fd.append('file', blob);
      const r = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      setRefImage({ assetId: r.id, url: fileUrl(r.url) });
      message.success('参考图已附加');
    } catch (e) {
      message.error((e as Error).message || '上传失败');
    }
    return false;
  }, [message]);

  // 轮询中持续滚到底
  useEffect(() => {
    if (turns.some((t) => t.status === 'pending')) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  const lbTurn = lightbox ? byId.get(lightbox.turnId) : null;
  const lbVariant = lbTurn?.variants[lightbox?.index ?? 0];

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="AI 画布"
        description="像聊天一样连续出图：每轮可出多个变体，基于任一历史图派生新分支，随时切回"
        extra={
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
              历史对话{conversations.length ? `（${conversations.length}）` : ''}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => void newConversation()}>新建对话</Button>
          </span>
        }
      />

      <div
        style={{
          display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap',
          background: '#fff', border: '1px solid rgba(28,27,46,.08)', borderRadius: 16, padding: 16,
        }}
      >
        {/* 对话流 */}
        <div ref={listRef} style={{ flex: '1 1 520px', minWidth: 300, maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
          {loading && !turns.length ? (
            <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
          ) : !path.length ? (
            <Empty description="还没有对话。描述你想要的图，或从下方输入框开始。" style={{ padding: '48px 0' }} />
          ) : (
            path.map((t, i) => {
              const prev = i > 0 ? path[i - 1] : null;
              const baseTurn = prev ? prev.variants[0] : null;
              return (
                <div key={t.id} style={{ marginBottom: 20 }}>
                  {t.kind === 'user' ? (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                      <div style={{ maxWidth: '78%', background: '#4F46E5', color: '#fff', padding: '10px 14px', borderRadius: 14, fontSize: 13.5, lineHeight: 1.6 }}>
                        {t.prompt}
                      </div>
                    </div>
                  ) : (
                    <div>
                      {/* 来源可追溯：标注这一轮基于哪张图 */}
                      {baseTurn && (
                        <div style={{ fontSize: 12, color: 'rgba(28,27,46,.5)', marginBottom: 8 }}>
                          基于上一轮的结果继续
                        </div>
                      )}
                      {/* 分支导航：同一父轮有多个子分支时 */}
                      {prev && (prev.children?.length ?? 0) > 1 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12.5 }}>
                          <Button size="small" onClick={() => switchBranch(prev.id, -1)} aria-label="上一个分支">‹</Button>
                          <Text type="secondary">
                            分支 {(prev.children?.indexOf(t.id) ?? 0) + 1} / {prev.children?.length}
                          </Text>
                          <Button size="small" onClick={() => switchBranch(prev.id, 1)} aria-label="下一个分支">›</Button>
                        </div>
                      )}

                      {t.status === 'pending' ? (
                        <div style={{ border: '1px dashed rgba(79,70,229,.35)', borderRadius: 12, padding: 32, textAlign: 'center', color: 'rgba(28,27,46,.55)' }}>
                          <Spin size="small" style={{ marginRight: 8 }} />
                          正在出图，可继续补充描述或切换到别的对话
                        </div>
                      ) : t.status === 'failed' ? (
                        <div style={{ border: '1px solid rgba(255,77,79,.35)', background: '#FFF2F0', borderRadius: 12, padding: 16, fontSize: 13 }}>
                          出图失败：{t.error ?? '未配置模型 Key'}
                          <Button size="small" style={{ marginLeft: 12 }} onClick={() => void regenerate(t)}>重试</Button>
                        </div>
                      ) : t.variants.length ? (
                        <div>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => setLightbox({ turnId: t.id, index: 0 })}
                            onKeyDown={(e) => e.key === 'Enter' && setLightbox({ turnId: t.id, index: 0 })}
                            style={{
                              borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(28,27,46,.08)', cursor: 'zoom-in',
                              background: '#F7F7FA', maxWidth: 420,
                            }}
                          >
                            <img src={fileUrl(t.variants[0].url)} alt={t.prompt} style={{ width: '100%', display: 'block' }} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                            <Tag color="purple">变体 {t.variants.length}</Tag>
                            <Button size="small" icon={<ReloadOutlined />} onClick={() => void regenerate(t)}>再出一版</Button>
                            <Button size="small" onClick={() => restore(t)}>改这段描述</Button>
                            {t.variants.length > 1 && (
                              <Button size="small" onClick={() => setLightbox({ turnId: t.id, index: 0 })}>看全部变体</Button>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 参数 + 输入 */}
        <div style={{ flex: '0 0 300px', width: 300 }}>
          <div style={{ fontSize: 12, color: 'rgba(28,27,46,.55)', marginBottom: 8 }}>出图参数</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>画幅</Text>
              <Segmented block size="small" value={ratio} options={RATIOS} onChange={(v) => setRatio(String(v))} />
            </div>
            {refImage && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>适配视频</Text>
                <Segmented
                  block
                  size="small"
                  value={fitVideo ? 'on' : 'off'}
                  options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启 16:9' }]}
                  onChange={(v) => setFitVideo(v === 'on')}
                />
              </div>
            )}
          </div>

          {refImage && (
            <div style={{ position: 'relative', marginBottom: 10 }}>
              <img src={refImage.url} alt="参考图" style={{ width: '100%', borderRadius: 10, border: '1px solid rgba(28,27,46,.1)' }} />
              <Tooltip title="移除参考图">
                <Button
                  size="small"
                  shape="circle"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setRefImage(null)}
                  style={{ position: 'absolute', top: 6, right: 6 }}
                />
              </Tooltip>
            </div>
          )}

          <Input.TextArea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            autoSize={{ minRows: 4, maxRows: 9 }}
            placeholder="描述你想要的画面。回车发送，Shift+回车换行。"
            disabled={sending}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button
              block
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={sending}
              onClick={() => void send()}
            >
              出图
            </Button>
            <label style={{ flex: 'none' }}>
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadRef(f); e.target.value = ''; }} />
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px',
                  border: '1px solid rgba(28,27,46,.15)', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                }}
              >
                <AppstoreOutlined /> 参考图
              </span>
            </label>
          </div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10, lineHeight: 1.7 }}>
            出图走后台任务，进度自动刷新；重新生成会追加为新变体，不会覆盖上一张。
          </Text>
        </div>
      </div>

      {/* 历史对话 */}
      <Drawer title="历史对话" open={historyOpen} onClose={() => setHistoryOpen(false)} width={380}>
        {conversations.length === 0 ? (
          <Empty description="还没有历史对话" />
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => { setActiveId(c.id); setHistoryOpen(false); }}
              style={{
                padding: '10px 12px', borderRadius: 10, cursor: 'pointer', marginBottom: 8,
                background: c.id === activeId ? 'rgba(79,70,229,.08)' : 'transparent',
                border: '1px solid rgba(28,27,46,.08)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title || '新对话'}
                </div>
                <div style={{ fontSize: 11.5, color: 'rgba(28,27,46,.5)' }}>
                  {new Date(c.updatedAt).toLocaleString('zh-CN')}
                </div>
              </div>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => { e.stopPropagation(); void removeConversation(c.id); }}
              />
            </div>
          ))
        )}
      </Drawer>

      {/* 灯箱：变体翻页 + 基于此图继续 */}
      <Modal
        open={!!lbVariant}
        onCancel={() => setLightbox(null)}
        footer={null}
        width={880}
        title={lbTurn?.prompt.slice(0, 40)}
      >
        {lbVariant && (
          <div>
            <img src={fileUrl(lbVariant.url)} alt={lbTurn?.prompt} style={{ width: '100%', borderRadius: 12 }} />
            {lbTurn && lbTurn.variants.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12 }}>
                <Button size="small" onClick={() => setLightbox({ turnId: lbTurn.id, index: (lightbox!.index - 1 + lbTurn.variants.length) % lbTurn.variants.length })}>‹ 上一张</Button>
                <Text type="secondary">{(lightbox?.index ?? 0) + 1} / {lbTurn.variants.length}</Text>
                <Button size="small" onClick={() => setLightbox({ turnId: lbTurn.id, index: (lightbox!.index + 1) % lbTurn.variants.length })}>下一张 ›</Button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <Button
                type="primary"
                onClick={() => {
                  if (lbTurn) void send(lbTurn.id);
                  setLightbox(null);
                }}
              >
                基于此图继续改
              </Button>
              <Paragraph type="secondary" style={{ flex: 1, minWidth: 220, margin: 0, fontSize: 12.5 }}>
                继续改会派生一个新分支，原来的链路仍然保留，可随时切回。
              </Paragraph>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
