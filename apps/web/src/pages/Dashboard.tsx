import {
  ArrowRightOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  HomeOutlined,
  PaperClipOutlined,
  PictureOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  VideoCameraOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { App as AntApp, Avatar, Button, Dropdown, Grid, Modal, Typography, Upload, theme } from 'antd';
import { Bubble, Sender, type BubbleItemType } from '@ant-design/x';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark';
import { useAuth } from '../store/AuthContext';
import { useChatStore } from '../store/ChatStore';
import { downloadMarkdown, downloadWord } from '../lib/mdExport';
import { useActiveConfig } from '../lib/configStore';
import { detectIntent } from '../lib/intent';
import { BRAND_GRADIENT } from '../theme/tokens';

const { Text, Title } = Typography;
const { useToken } = theme;

/** 首页快捷卡（功能入口；点击填入示例需求并发送） */
const QUICK_CARDS = [
  {
    key: 'plan',
    icon: <HomeOutlined />,
    title: '生成智能方案',
    desc: '户型 → 全屋方案 + 可编辑 PPT',
    prompt: '给 140㎡ 三室两厅做一份全屋智能方案',
    tone: '#5B5BF0',
  },
  {
    key: 'poster',
    icon: <PictureOutlined />,
    title: '做一张海报',
    desc: '产品 / 场景效果图',
    prompt: '帮我们的智能门锁做一张产品海报效果图',
    tone: '#D9A036',
  },
  {
    key: 'video',
    icon: <VideoCameraOutlined />,
    title: '出一条视频',
    desc: '产品 / 案例演示短片',
    prompt: '把客厅观影场景图做成一条 10 秒动态视频',
    tone: '#4DD4D4',
  },
  {
    key: 'copy',
    icon: <FileTextOutlined />,
    title: '文案仿写',
    desc: '工地日常 → 获客内容',
    prompt: '帮我写一条今天水电交底工地的朋友圈文案',
    tone: '#5BA86B',
  },
  {
    key: 'agent',
    icon: <RobotOutlined />,
    title: '找个智能体',
    desc: '文案 / 脚本 / 经营诊断',
    prompt: '推荐一个适合短视频脚本创作的智能体',
    tone: '#C37FB0',
  },
];

/** 输入卡底部功能 chip：每个 chip 真实可点击，触发对应能力（避免装饰性死按钮） */
const INPUT_CHIPS: { key: 'attachment' | 'image' | 'video' | 'plan'; label: string; helper: string; route: string; needsAttachment?: boolean }[] = [
  { key: 'attachment', label: '上传附件', helper: '把图片/户型/对话纪要上传到资料库', route: '/content', needsAttachment: true },
  { key: 'image', label: '图生图', helper: '上传参考图后生图', route: '/image' },
  { key: 'video', label: '生视频', helper: '首帧图/纯文字生成短视频', route: '/video' },
  { key: 'plan', label: '生方案', helper: '9 页可编辑 PPT 智能方案', route: '/plan' },
];

/** 能力状态条（宽屏一行铺满，窄屏自动换行） */
const CAPABILITY_TAGS = ['AI 智能体对话', '空间效果图', '演示短视频', '9 页方案 PPT', '设备点位图', '智能报价'];

interface AttachmentItem {
  uid: string;
  name: string;
  size: number;
  kind: 'image' | 'file';
  dataUrl: string;
}

/**
 * 逐条回复的操作条：复制 / 下载 Markdown / 下载 Word。
 *
 * 只挂在 AI 回复上（见下方 bubbleRoles.ai.footer）——用户自己说的话没什么可导出的。
 * 复制必须带降级：非 HTTPS 或老浏览器里 navigator.clipboard 不可用，
 * 直接报"复制失败"等于让人自己去选文本。
 */
function ChatActions({ content }: { content: string }): ReactNode | null {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);

  if (!content.trim()) return null;

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } else {
        message.error('复制失败，请手动选择文本复制');
      }
    }
  };

  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
      <Button size="small" type="text" onClick={() => void copy()} style={{ fontSize: 12 }}>
        {copied ? '已复制' : '复制'}
      </Button>
      <Button size="small" type="text" onClick={() => downloadMarkdown(content)} style={{ fontSize: 12 }}>
        下载 Markdown
      </Button>
      <Button size="small" type="text" onClick={() => downloadWord(content)} style={{ fontSize: 12 }}>
        下载 Word
      </Button>
    </div>
  );
}

export function Dashboard(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = useToken();
  const { user } = useAuth();
  const screens = Grid.useBreakpoint();
  const isWide = screens.md ?? false;
  const navigate = useNavigate();

  const { activeConversation, setActiveKey, sending, createNew, send } = useChatStore();
  const { config, refresh: refreshConfig } = useActiveConfig();
  const location = useLocation();
  const [input, setInput] = useState('');
  // 意图建议：命中「要去某个板块」的关键词时给一条可点提示；不自动跳转、不劫持对话
  const intent = useMemo(() => detectIntent(input), [input]);
  const [intentDismissed, setIntentDismissed] = useState('');
  const suggest = intent && intent.key !== 'chat' && intent.label !== intentDismissed ? intent : null;
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentItem | null>(null);
  const agentRef = useRef<string | undefined>(undefined);
  const promptRef = useRef<string | undefined>(undefined);
  const [agentName, setAgentName] = useState<string | undefined>();

  // 智能体市场点击卡片进入：携带智能体名（自建智能体另带人设提示词），首条消息归属该智能体
  // 百宝箱工具卡进入：携带预填提示词
  useEffect(() => {
    const st = location.state as { agent?: string; prompt?: string; systemPrompt?: string } | null;
    if (st?.agent) {
      agentRef.current = st.agent;
      promptRef.current = st.systemPrompt;
      setAgentName(st.agent);
    }
    if (st?.prompt) setInput(st.prompt);
  }, [location.state]);

  const messages = activeConversation?.messages ?? [];
  const isChatting = messages.length > 0;
  const currentAgent = activeConversation?.agent ?? agentName;

  // 流式宽度：内容区随视口铺满（4K 同样拉宽不留大片空白），可读性由气泡/卡片自身限宽保证
  const contentMaxWidth = '100%';

  const bubbleItems = useMemo<BubbleItemType[]>(() => {
    const list: BubbleItemType[] = messages.map((m) => ({
      key: m.id,
      role: m.role === 'user' ? 'user' : 'ai',
      // 操作条只挂在 AI 回复下：用户自己说的话没什么可导出的。
      // （不用 Bubble 的 footer 槽——它的类型不接受这个签名，直接包进 content 更省）
      content: m.role === 'user'
        ? m.content
        : (
          <>
            {m.content}
            <ChatActions content={m.content} />
          </>
        ),
    }));
    if (sending) {
      list.push({ key: 'pending', role: 'ai', content: '', loading: true });
    }
    return list;
  }, [messages, sending]);

  const bubbleRoles = useMemo(
    () => ({
      user: {
        placement: 'end' as const,
        avatar: (
          <Avatar size={32} style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}>
            {(user?.displayName ?? 'U').slice(0, 1)}
          </Avatar>
        ),
        style: { background: token.colorPrimary, color: '#ffffff', border: 'none', maxWidth: 'min(62%, 680px)' },
      },
      ai: {
        placement: 'start' as const,
        avatar: <BrandMark size={32} />,
        style: {
          maxWidth: 'min(62%, 680px)',
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          boxShadow: token.boxShadowTertiary,
        },
      },
    }),
    [token.colorPrimary, token.colorPrimaryBg, token.colorBgContainer, token.colorBorderSecondary, token.boxShadowTertiary, user?.displayName],
  );

  const handleSubmit = (value: string): void => {
    const content = value.trim();
    if (!content || sending) return;
    // 附件以摘要形式追加到提示词中，模型可参考（图片用 <img src> data URL）
    // 附件内容随请求上行给模型（后端按图片/文本类分别处理），
    // 这里不再拼「文件名(类型,大小)」的假摘要——那只会让模型以为自己看过附件
    const promptWithAttachments = content;
    send(promptWithAttachments, agentRef.current, promptRef.current, attachments);
    agentRef.current = undefined;
    promptRef.current = undefined;
    setInput('');
    setAttachments([]);
    // 模型方案若有变化，刷新活动配置展示
    void refreshConfig();
  };

  /** 读取文件为 dataURL（≤4MB，仅类型白名单；大文件走素材库/产品中心更合适） */
  const readFile = (file: File): Promise<AttachmentItem> =>
    new Promise((resolve, reject) => {
      if (file.size > 4 * 1024 * 1024) {
        reject(new Error('附件单文件 ≤4MB；大文件请到「内容提取」上传'));
        return;
      }
      if (!/^image\/(png|jpe?g|webp|gif)$|^text\/|^application\/(pdf|json|zip)$/.test(file.type)) {
        reject(new Error('不支持的附件类型'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          uid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          kind: file.type.startsWith('image/') ? 'image' : 'file',
          dataUrl: String(reader.result),
        });
      reader.onerror = () => reject(new Error('读取失败'));
      reader.readAsDataURL(file);
    });

  const onUpload = useCallback(
    async (file: File) => {
      try {
        const item = await readFile(file);
        setAttachments((prev) => [...prev, item]);
        if (item.kind === 'image') setAttachmentPreview(item);
        return false; // 阻止 antd Upload 默认上传
      } catch (e) {
        message.error((e as Error).message);
        return false;
      }
    },
    [message],
  );

  const removeAttachment = (uid: string): void => {
    setAttachments((prev) => prev.filter((a) => a.uid !== uid));
  };

  /** chip 点击：图片/视频/方案直接跳到对应能力页，上传附件打开「内容提取」 */
  const onChipClick = (key: 'attachment' | 'image' | 'video' | 'plan'): void => {
    if (key === 'attachment') {
      message.info('已为您打开「内容提取」上传资料，提取后可同步到产品中心', 2);
      navigate('/content');
      return;
    }
    const route = INPUT_CHIPS.find((c) => c.key === key)?.route ?? '/';
    message.info(`已为你打开「${INPUT_CHIPS.find((c) => c.key === key)?.label}」`, 1.5);
    navigate(route);
  };

  const capabilityRoute: Record<string, string> = {
    'AI 智能体对话': '/agents',
    '空间效果图': '/image',
    '演示短视频': '/video',
    '9 页方案 PPT': '/plan',
    '设备点位图': '/device-layout',
    '智能报价': '/quote',
  };

  /** 输入区模型方案下拉：点击切到模型配置中心 */
  const modelSwitchItems = [
    { key: 'current', label: `当前：${config.profileName || '默认（.env）'} · ${config.chatModel || 'MiniMax-M3'}`, disabled: true },
    { type: 'divider' as const },
    { key: 'config', label: '去配置/切换方案', icon: <CloudServerOutlined />, onClick: () => navigate('/model-config') },
  ];

  return (
    <div style={{ minHeight: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', background: token.colorBgLayout, position: 'relative' }}>
      {/* 品牌光晕背景（仅新对话页；pointer-events 穿透） */}
      {!isChatting && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: -220,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 'min(1100px, 96%)',
              height: 520,
              background: BRAND_GRADIENT,
              opacity: 0.09,
              filter: 'blur(90px)',
              borderRadius: '50%',
            }}
          />
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div style={{ maxWidth: contentMaxWidth, width: '100%', margin: '0 auto', padding: isChatting ? (isWide ? '24px 24px 16px' : '16px') : isWide ? 'clamp(40px, 12vh, 130px) 24px 16px' : '24px 16px 16px' }}>
          {isChatting ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <Text strong style={{ fontSize: 15 }}>{currentAgent ?? '智居助手 · 通用对话'}</Text>
                <Button size="small" onClick={() => setActiveKey(null)}>
                  返回新对话
                </Button>
              </div>
              <Bubble.List items={bubbleItems} autoScroll style={{ maxWidth: '100%' }} role={bubbleRoles} />
            </>
          ) : (
            <>
              {/* 居中欢迎区 */}
              <div style={{ textAlign: 'center', marginBottom: 28 }}>
                <Avatar
                  size={isWide ? 84 : 68}
                  src={<BrandMark size={isWide ? 84 : 68} />}
                  shape="circle"
                  style={{ marginBottom: 14, boxShadow: token.boxShadowSecondary }}
                />
                <Title level={1} style={{ fontSize: isWide ? 'clamp(34px, 2.6vw, 46px)' : 28, fontWeight: 700, marginBottom: 8 }}>
                  Hi{user?.displayName ? `，${user.displayName}` : ''}，欢迎回来
                </Title>
                <Text type="secondary" style={{ fontSize: isWide ? 17 : 14, lineHeight: 1.7 }}>
                  说一句话，出方案 · 出图 · 出视频 · 出文案——智能家居获客与交付，全程帮你搞定
                </Text>
              </div>

              {/* 大输入卡：附件 + 文本 + 模型方案 + 发送 */}
              <div
                style={{
                  background: token.colorBgContainer,
                  borderRadius: 18,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  boxShadow: token.boxShadowSecondary,
                  padding: attachments.length ? '14px 16px 10px' : isWide ? '22px 28px 14px' : '14px 16px 10px',
                  marginBottom: 12,
                }}
              >
                {/* 附件缩略带 */}
                {attachments.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                    {attachments.map((a) => (
                      <div
                        key={a.uid}
                        style={{
                          position: 'relative',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 8px 4px 4px',
                          background: token.colorFillTertiary,
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      >
                        {a.kind === 'image' ? (
                          <img
                            src={a.dataUrl}
                            alt={a.name}
                            onClick={() => setAttachmentPreview(a)}
                            style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4, cursor: 'pointer' }}
                          />
                        ) : (
                          <PaperClipOutlined style={{ color: token.colorTextSecondary }} />
                        )}
                        <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                        <Button type="text" size="small" onClick={() => removeAttachment(a.uid)} style={{ padding: '0 4px', height: 20 }}>
                          ×
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}

{suggest ? (
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      marginBottom: 8, padding: '6px 12px', borderRadius: 10,
                      background: token.colorPrimaryBg, fontSize: 12.5,
                    }}
                  >
                    <ThunderboltFilled style={{ color: token.colorPrimary }} />
                    <span>
                      识别到你要做「{suggest.label}」
                      <Text type="secondary" style={{ marginInlineStart: 6 }}>（命中「{suggest.hit}」）</Text>
                    </span>
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => { navigate(suggest.route); setInput(''); }}
                    >
                      前往{suggest.label}
                    </Button>
                    <Button size="small" type="text" onClick={() => setIntentDismissed(suggest.label)}>
                      不用，直接对话
                    </Button>
                  </div>
                ) : null}

                <Sender
                  value={input}
                  onChange={setInput}
                  onSubmit={handleSubmit}
                  loading={sending}
                  placeholder="说说你想创作什么…例如：给 140㎡ 三室两厅做一份全屋智能方案"
                  suffix={false}
                  header={
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '4px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 12, color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>当前模型</span>
                        <Dropdown menu={{ items: modelSwitchItems }} placement="bottomLeft">
                          <Button
                            size="small"
                            type="text"
                            style={{
                              padding: '2px 10px',
                              height: 24,
                              fontSize: 12,
                              color: token.colorPrimary,
                              background: token.colorPrimaryBg,
                              borderRadius: 9999,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              maxWidth: '100%',
                            }}
                          >
                            <CloudServerOutlined style={{ fontSize: 12 }} />
                            <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {config.profileName || '默认（.env）'} · {config.chatModel || 'MiniMax-M3'}
                            </span>
                          </Button>
                        </Dropdown>
                      </div>
                      <Upload
                        beforeUpload={onUpload}
                        showUploadList={false}
                        accept="image/*,text/*,.pdf,.json,.zip"
                      >
                        <Button type="text" size="small" icon={<PaperClipOutlined />}>
                          添加附件
                        </Button>
                      </Upload>
                    </div>
                  }
                  footer={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8 }}>
                      {INPUT_CHIPS.map((chip) => (
                        <span
                          key={chip.key}
                          role="button"
                          tabIndex={0}
                          onClick={() => onChipClick(chip.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onChipClick(chip.key);
                            }
                          }}
                          title={chip.helper}
                          style={{
                            fontSize: 12,
                            padding: '3px 12px',
                            borderRadius: 9999,
                            background: token.colorFillTertiary,
                            color: token.colorTextSecondary,
                            cursor: 'pointer',
                            userSelect: 'none',
                          }}
                        >
                          {chip.label}
                        </span>
                      ))}
                      <div style={{ flex: 1 }} />
                      <Button
                        shape="circle"
                        type="primary"
                        icon={<SendOutlined />}
                        onClick={() => handleSubmit(input)}
                        loading={sending}
                        disabled={!input.trim()}
                        title="发送"
                        style={{
                          background: BRAND_GRADIENT,
                          color: '#ffffff',
                          border: 'none',
                          boxShadow: 'none',
                        }}
                      />
                    </div>
                  }
                />
              </div>

              {/* 附件图片预览弹窗（应用内可关闭返回，不离开工作台） */}
              <Modal
                title={attachmentPreview?.name ?? ''}
                open={!!attachmentPreview && attachmentPreview.kind === 'image'}
                onCancel={() => setAttachmentPreview(null)}
                footer={<Button type="primary" onClick={() => setAttachmentPreview(null)}>返回编辑</Button>}
                width={720}
                destroyOnHidden
              >
                {attachmentPreview ? (
                  <img src={attachmentPreview.dataUrl} alt={attachmentPreview.name} style={{ width: '100%', borderRadius: 12 }} />
                ) : null}
              </Modal>

              {/* 能力状态条：每个标签可点击进入对应能力页 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 30 }}>
                {CAPABILITY_TAGS.map((t) => {
                  const route = capabilityRoute[t];
                  const content = (
                    <span
                      style={{
                        fontSize: 12,
                        padding: '3px 12px',
                        borderRadius: 9999,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        background: token.colorBgContainer,
                        color: token.colorTextSecondary,
                        cursor: route ? 'pointer' : 'default',
                      }}
                    >
                      {t}
                    </span>
                  );
                  return route ? (
                    <div
                      key={t}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(route)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && navigate(route)}
                    >
                      {content}
                    </div>
                  ) : (
                    <div key={t}>{content}</div>
                  );
                })}
              </div>

              {/* 快捷卡：auto-fit 自适应列数，宽屏铺满 */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                  gap: 14,
                }}
              >
                {QUICK_CARDS.map((card) => (
                  <div
                    key={card.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSubmit(card.prompt)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSubmit(card.prompt);
                    }}
                    style={{
                      background: token.colorBgContainer,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: 16,
                      padding: '22px 20px',
                      minHeight: 148,
                      cursor: 'pointer',
                      transition: 'transform .18s, box-shadow .18s, border-color .18s',
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.transform = 'translateY(-3px)';
                      el.style.boxShadow = token.boxShadowSecondary;
                      el.style.borderColor = card.tone + '66';
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.transform = 'none';
                      el.style.boxShadow = 'none';
                      el.style.borderColor = token.colorBorderSecondary;
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: card.tone + '1a',
                        color: card.tone,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 19,
                        marginBottom: 14,
                      }}
                    >
                      {card.icon}
                    </div>
                    <Text strong style={{ fontSize: 15, marginBottom: 4 }}>
                      {card.title}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                      {card.desc}
                    </Text>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {isChatting ? (
        <footer
          style={{
            flex: 'none',
            padding: isWide ? '8px 24px 20px' : '8px 16px 16px',
            background: token.colorBgLayout,
          }}
        >
          <div style={{ maxWidth: '100%', margin: '0 auto' }}>
{suggest ? (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                marginBottom: 8, padding: '6px 12px', borderRadius: 10,
                background: token.colorPrimaryBg, fontSize: 12.5,
              }}
            >
              <ThunderboltFilled style={{ color: token.colorPrimary }} />
              <span>
                识别到你要做「{suggest.label}」
                <Text type="secondary" style={{ marginInlineStart: 6 }}>（命中「{suggest.hit}」）</Text>
              </span>
              <Button
                size="small"
                type="primary"
                onClick={() => { navigate(suggest.route); setInput(''); }}
              >
                前往{suggest.label}
              </Button>
              <Button size="small" type="text" onClick={() => setIntentDismissed(suggest.label)}>
                不用，直接对话
              </Button>
            </div>
                ) : null}

            <Sender
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              loading={sending}
              placeholder="描述你的需求，例如：为 120㎡ 三居生成一套无主灯设计方案"
            />
            <Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 12, marginTop: 8 }}>
              内容由所配置的模型实时生成，按额度计费
            </Text>
          </div>
        </footer>
      ) : (
        <div style={{ textAlign: 'center', padding: '0 0 16px', position: 'relative' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            对话 / 生图 / 生视频 / 方案 PPT 全链路已接通 ·{' '}
            <a
              onClick={() => {
                createNew();
                setActiveKey(null);
              }}
            >
              新对话
            </a>
          </Text>
        </div>
      )}
    </div>
  );
}
