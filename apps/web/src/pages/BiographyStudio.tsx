import { ArrowRightOutlined, PlusOutlined, ReadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Empty, Grid, Tag, Typography, theme } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useChatStore } from '../store/ChatStore';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text, Paragraph } = Typography;
const { useToken } = theme;

/** 传记智能体名：ChatStore 会话以此标识归属「短视频工作台」档案 */
const BIO_AGENT = '你的专属传记智能体';

/** 三种专访方式：选择后以不同人设 systemPrompt 进入工作台对话（真实影响采访风格） */
const WAYS: { key: string; label: string; desc: string; prompt: string }[] = [
  {
    key: 'dialogue',
    label: '真人对话式专访',
    desc: '像老朋友一样一句一句采访，每次只问一个问题，等我回答后再问下一个',
    prompt:
      '你是资深人物专访记者，正在为智能家居从业者做一篇人物志。用老朋友聊天的口吻一句一句采访，每次只提一个问题，等用户回答后再追问下一个；问题覆盖起点、关键转折、踩过的坎、坚持的信念。素材足够后，写成一篇 800 字内、有细节有金句的人物专访稿。',
  },
  {
    key: 'notes',
    label: '边聊边记',
    desc: '自由开聊，智能体边问边记录关键素材，随时可让它汇总',
    prompt:
      '你是人物传记记录员。用户自由讲述创业故事与经历，你边听边用「已记录：…」简短确认关键素材（时间、事件、人物、金句），并适时补问缺失环节；用户说「汇总一下」时，把已记录素材整理成人物志大纲。语气自然，不打断用户的表达节奏。',
  },
  {
    key: 'half-draft',
    label: '聊够一半成稿',
    desc: '聊到素材够了，自动整理出半成稿，确认后补完全文',
    prompt:
      '你是人物传记写作教练。先连续提出 5-8 个覆盖出身、转折、低谷、信念、愿景的问题，用户答完后直接输出一篇半成稿人物志（标注哪些段落需要用户补充细节），用户补充后迭代为完整成稿。',
  },
];

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BiographyStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = useToken();
  const screens = Grid.useBreakpoint();
  const isWide = screens.md ?? false;
  const navigate = useNavigate();
  const { conversations, setActiveKey, createNew } = useChatStore();

  const [way, setWay] = useState<string>('dialogue');

  /** 我的 IP 档案 = 归属传记智能体的工作台会话（localStorage 持久化，跨刷新不丢） */
  const profiles = useMemo(
    () =>
      conversations
        .filter((c) => c.agent?.includes('传记'))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  const startInterview = (): void => {
    const w = WAYS.find((x) => x.key === way) ?? WAYS[0];
    message.info(`已按「${w.label}」开始专访，在工作台逐句对话即可`, 2);
    navigate('/', { state: { agent: BIO_AGENT, systemPrompt: w.prompt, prompt: '我想做一次人物专访。' } });
  };

  const resume = (key: string): void => {
    setActiveKey(key);
    navigate('/');
  };

  const viewAllChats = (): void => {
    createNew();
    navigate('/');
  };

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="短视频工作台"
        description="别人用简介介绍自己，你值得一篇专访。选一种专访方式，像老朋友一样聊出你的人物志；档案自动保存，之后写短视频脚本、直播话术都能引用"
        extra={
          <Button
            type="primary"
            size={isWide ? 'large' : 'middle'}
            icon={<PlusOutlined />}
            onClick={startInterview}
            style={{ background: BRAND_GRADIENT, border: 'none', fontWeight: 600 }}
          >
            开始一次专访
          </Button>
        }
      />

      {/* 专访方式：三卡 auto-fit 铺满，宽屏拉宽无留白；卡片真实可选并影响进入对话的人设 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 14,
          marginBottom: 18,
        }}
      >
        {WAYS.map((w) => {
          const active = way === w.key;
          return (
            <Card
              key={w.key}
              role="button"
              tabIndex={0}
              onClick={() => setWay(w.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setWay(w.key);
                }
              }}
              styles={{ body: { padding: '18px 18px 16px' } }}
              style={{
                cursor: 'pointer',
                border: active ? `1.5px solid ${token.colorPrimary}` : `1px solid ${token.colorBorderSecondary}`,
                boxShadow: active ? token.boxShadowSecondary : 'none',
                background: active ? token.colorPrimaryBg : token.colorBgContainer,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text strong style={{ fontSize: 15 }}>{w.label}</Text>
                <Tag color={active ? 'geekblue' : 'default'} style={{ marginInlineEnd: 0 }}>{active ? '已选择' : '可选'}</Tag>
              </div>
              <Paragraph type="secondary" style={{ fontSize: 12.5, lineHeight: 1.7, marginBottom: 0 }}>
                {w.desc}
              </Paragraph>
            </Card>
          );
        })}
      </div>

      {/* 提示条：当前方式 + 行动按钮 */}
      <Card styles={{ body: { padding: '14px 18px' } }} style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 13 }}>
            当前方式：<Text strong>{WAYS.find((x) => x.key === way)?.label}</Text>
            <Text type="secondary"> · 进入工作台后逐句对话，素材自动沉淀为你的 IP 档案</Text>
          </Text>
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            onClick={startInterview}
            style={{ background: BRAND_GRADIENT, border: 'none' }}
          >
            新建 / 导入个人 IP 档案
          </Button>
        </div>
      </Card>

      {/* 我的 IP 档案：真实读取传记会话，可继续访谈 */}
      <Card
        title="我的个人 IP 档案"
        extra={<a onClick={viewAllChats}>查看全部历史对话 →</a>}
        styles={{ body: { padding: profiles.length ? 12 : 24 } }}
      >
        {profiles.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                <ReadOutlined /> 还没有档案。做一次专访，之后所有短视频脚本、直播话术都会引用它——做过的，不用再做一遍。
              </span>
            }
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 10,
            }}
          >
            {profiles.map((p) => (
              <div
                key={p.key}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 12,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  background: token.colorBgContainer,
                }}
              >
                <Text strong ellipsis style={{ fontSize: 14 }}>{p.label}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {p.messages.length} 条对话 · 最近 {formatTime(p.updatedAt)}
                </Text>
                <div>
                  <Button size="small" type="primary" ghost onClick={() => resume(p.key)}>查看 / 继续专访</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
