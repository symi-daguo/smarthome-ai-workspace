import { FireFilled } from '@ant-design/icons';
import { App as AntApp, Button, Dropdown, Empty, Grid, Switch, Typography, theme } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENT_CATEGORIES, SEED_AGENTS, type AgentDef } from '../data/agents';

const { Text, Title } = Typography;

type SortKey = 'default' | 'usage' | 'name';

const SORT_LABELS: Record<SortKey, string> = {
  default: '默认排序',
  usage: '按热度',
  name: '按名称',
};

export function AgentMarket(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const [category, setCategory] = useState('全部');
  const [sort, setSort] = useState('default' as SortKey);
  const [agents, setAgents] = useState<AgentDef[]>(SEED_AGENTS);

  const openAgent = (a: AgentDef): void => {
    if (!a.enabled) {
      message.warning(`「${a.name}」未启用，先打开卡片右下角开关`);
      return;
    }
    navigate('/', { state: { agent: a.name } });
  };

  const visible = useMemo(() => {
    let list = agents;
    if (category === '我的智能体') list = [];
    else if (category !== '全部') list = list.filter((a) => a.category === category);
    if (sort === 'usage') list = [...list].sort((a, b) => b.usage - a.usage);
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return list;
  }, [agents, category, sort]);

  const toggle = (key: string, enabled: boolean): void => {
    setAgents((prev) => prev.map((a) => (a.key === key ? { ...a, enabled } : a)));
  };

  return (
    <div style={{ paddingBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 20,
        }}
      >
        <Title level={3} style={{ margin: 0, marginRight: 16 }}>全部智能体</Title>
        {AGENT_CATEGORIES.map((c) => {
          const active = category === c;
          return (
            <span
              key={c}
              role="button"
              tabIndex={0}
              onClick={() => setCategory(c)}
              onKeyDown={(e) => e.key === 'Enter' && setCategory(c)}
              style={{
                padding: '7px 16px',
                borderRadius: 9999,
                fontSize: 14,
                cursor: 'pointer',
                userSelect: 'none',
                background: active ? token.colorPrimaryBg : 'transparent',
                color: active ? token.colorPrimary : token.colorTextSecondary,
                fontWeight: active ? 600 : 400,
              }}
            >
              {c}
            </span>
          );
        })}
        <div style={{ flex: 1 }} />
        <Dropdown
          menu={{
            items: (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ key: k, label: SORT_LABELS[k] })),
            onClick: ({ key }) => setSort(key as SortKey),
          }}
        >
          <Button type="text">{SORT_LABELS[sort]} ▾</Button>
        </Dropdown>
      </div>

      {visible.length === 0 ? (
        <Empty
          description={category === '我的智能体' ? '还没有自建智能体，可在「智能百宝箱 - 定制智能体」创建' : '该分类下暂无智能体'}
          style={{ marginTop: 64 }}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${screens.md ? 260 : 220}px, 1fr))`,
            gap: 16,
          }}
        >
          {visible.map((a) => (
            <div
              key={a.key}
              role="button"
              tabIndex={0}
              onClick={() => openAgent(a)}
              onKeyDown={(e) => e.key === 'Enter' && openAgent(a)}
              style={{
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 16,
                overflow: 'hidden',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  height: 150,
                  background: `url(${a.cover}) center/cover no-repeat, ${a.tone}`,
                }}
              />
              <div style={{ padding: '12px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 4 }}>
                  {a.name}
                </Text>
                <Text
                  type="secondary"
                  style={{
                    fontSize: 12.5,
                    lineHeight: '19px',
                    flex: 1,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {a.description}
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', marginTop: 10 }}>
                  <Text type="secondary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <FireFilled style={{ color: '#F5533D' }} /> 使用热度 {a.usage} 次
                  </Text>
                  <div style={{ flex: 1 }} />
                  <Switch
                    size="small"
                    checked={a.enabled}
                    onClick={(_, e) => e.stopPropagation()}
                    onChange={(checked) => {
                      toggle(a.key, checked);
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
