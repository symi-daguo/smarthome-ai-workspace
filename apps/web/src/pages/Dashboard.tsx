import {
  ArrowRightOutlined,
  FileTextOutlined,
  HomeOutlined,
  PictureOutlined,
  RobotOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Grid, Typography, theme } from 'antd';
import { Bubble, Sender, type BubbleItemType } from '@ant-design/x';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark';
import { useAuth } from '../store/AuthContext';
import { useChatStore } from '../store/ChatStore';
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

/** 输入卡底部功能 chip */
const INPUT_CHIPS = ['上传附件', '图生图', '生视频', '生方案'];

/** 能力状态条（宽屏一行铺满，窄屏自动换行） */
const CAPABILITY_TAGS = ['AI 智能体对话', '空间效果图', '演示短视频', '9 页方案 PPT', '设备点位图', '智能报价'];

export function Dashboard(): ReactNode {
  const { token } = useToken();
  const { user } = useAuth();
  const screens = Grid.useBreakpoint();
  const isWide = screens.md ?? false;
  const isXl = screens.xl ?? false;
  const isXxl = screens.xxl ?? false;

  const { activeConversation, setActiveKey, sending, createNew, send } = useChatStore();
  const location = useLocation();
  const [input, setInput] = useState('');
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

  // 流式宽度：随视口增长（小屏全宽 → 宽屏 1380 封顶），不再锁死 960
  const contentMaxWidth = isChatting
    ? 'clamp(720px, 86%, 1380px)'
    : isXxl
      ? 1380
      : isXl
        ? 1200
        : isWide
          ? 960
          : '100%';

  const bubbleItems = useMemo<BubbleItemType[]>(() => {
    const list: BubbleItemType[] = messages.map((m) => ({
      key: m.id,
      role: m.role === 'user' ? 'user' : 'ai',
      content: m.content,
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
    if (!content) return;
    send(content, agentRef.current, promptRef.current);
    agentRef.current = undefined;
    promptRef.current = undefined;
    setInput('');
  };

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

              {/* 大输入卡 */}
              <div
                style={{
                  background: token.colorBgContainer,
                  borderRadius: 18,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  boxShadow: token.boxShadowSecondary,
                  padding: isWide ? '22px 28px 14px' : '14px 16px 10px',
                  marginBottom: 20,
                }}
              >
                <Sender
                  value={input}
                  onChange={setInput}
                  onSubmit={handleSubmit}
                  loading={sending}
                  placeholder="说说你想创作什么…例如：给 140㎡ 三室两厅做一份全屋智能方案"
                  suffix={false}
                  footer={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8 }}>
                      {INPUT_CHIPS.map((chip) => (
                        <span
                          key={chip}
                          onClick={() => setInput((prev) => (prev ? `${prev}（${chip}）` : chip))}
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
                          {chip}
                        </span>
                      ))}
                      <div style={{ flex: 1 }} />
                      <Button
                        shape="circle"
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        onClick={() => handleSubmit(input)}
                        loading={sending}
                        style={{
                          background: '#151515',
                          color: '#ffffff',
                          border: 'none',
                          boxShadow: 'none',
                        }}
                      />
                    </div>
                  }
                />
              </div>

              {/* 能力状态条 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 30 }}>
                {CAPABILITY_TAGS.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: 12,
                      padding: '3px 12px',
                      borderRadius: 9999,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      background: token.colorBgContainer,
                      color: token.colorTextSecondary,
                    }}
                  >
                    {t}
                  </span>
                ))}
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
          <div style={{ maxWidth: 'clamp(720px, 86%, 1380px)', margin: '0 auto' }}>
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
