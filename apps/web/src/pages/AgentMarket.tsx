import { DeleteOutlined, FireFilled, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Dropdown, Empty, Form, Grid, Input, Modal, Popconfirm, Switch, Typography, theme } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENT_CATEGORIES, SEED_AGENTS, type AgentDef } from '../data/agents';
import { listCustomAgents, createCustomAgent, deleteCustomAgent, type CustomAgent } from '../data/customAgents';

const { Text, Title } = Typography;

type SortKey = 'default' | 'usage' | 'name';

const SORT_LABELS: Record<SortKey, string> = {
  default: '默认排序',
  usage: '按热度',
  name: '按名称',
};

interface CreateForm {
  name: string;
  /** 选填：未填写时 validateFields 返回 undefined */
  description?: string;
  systemPrompt: string;
}

export function AgentMarket(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const [category, setCategory] = useState('全部');
  const [sort, setSort] = useState('default' as SortKey);
  const [agents, setAgents] = useState<AgentDef[]>(SEED_AGENTS);
  const [custom, setCustom] = useState<CustomAgent[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<CreateForm>();

  // 自建智能体已落库，进入页面拉取当前租户的列表
  useEffect(() => {
    let alive = true;
    void listCustomAgents()
      .then((list) => {
        if (alive) setCustom(list);
      })
      .catch(() => {
        /* 拉取失败保持空列表，不打断预置智能体浏览 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const openAgent = (a: AgentDef): void => {
    if (!a.enabled) {
      message.warning(`「${a.name}」未启用，先打开卡片右下角开关`);
      return;
    }
    // 显式携带该角色的人设与首条任务：进入工作台即以该角色身份对话（不靠名字猜测）
    navigate('/', { state: { agent: a.name, systemPrompt: a.systemPrompt, prompt: a.starterPrompt } });
  };

  const openCustom = (a: CustomAgent): void => {
    navigate('/', {
      state: {
        agent: a.name,
        systemPrompt: a.systemPrompt,
        prompt: `你好，我想让你以「${a.name}」的身份帮我完成第一个任务：请先用一句话确认你的职责，然后问我需要你处理的具体事项。`,
      },
    });
  };

  const visible = useMemo(() => {
    let list = agents;
    if (category !== '全部' && category !== '我的智能体') list = list.filter((a) => a.category === category);
    if (sort === 'usage') list = [...list].sort((a, b) => b.usage - a.usage);
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return list;
  }, [agents, category, sort]);

  const toggle = (key: string, enabled: boolean): void => {
    setAgents((prev) => prev.map((a) => (a.key === key ? { ...a, enabled } : a)));
  };

  const submitCreate = async (): Promise<void> => {
    let v: CreateForm;
    try {
      v = await form.validateFields();
    } catch {
      return; // 校验失败由 antd 字段红字提示，无需额外处理
    }
    try {
      const agent = await createCustomAgent({
        name: v.name.trim(),
        description: v.description?.trim() ?? '',
        systemPrompt: v.systemPrompt.trim(),
      });
      setCustom((prev) => [agent, ...prev]);
      setCreateOpen(false);
      form.resetFields();
      message.success('智能体已创建，点击卡片即可对话');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    }
  };

  const removeCustom = async (id: string): Promise<void> => {
    try {
      await deleteCustomAgent(id);
      setCustom((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div style={{ width: '100%', paddingBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 20,
        }}
      >
        <Title level={3} style={{ margin: 0, marginRight: 16 }}>{category === '我的智能体' ? '我的智能体' : '全部智能体'}</Title>
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
        {category === '我的智能体' ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
            style={{ background: token.colorPrimary }}
          >
            新建智能体
          </Button>
        ) : (
          <Dropdown
            menu={{
              items: (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ key: k, label: SORT_LABELS[k] })),
              onClick: ({ key }) => setSort(key as SortKey),
            }}
          >
            <Button type="text">{SORT_LABELS[sort]} ▾</Button>
          </Dropdown>
        )}
      </div>

      {category === '我的智能体' ? (
        custom.length === 0 ? (
          <Empty
            description={<Text type="secondary">还没有自建智能体，点右上角「新建智能体」，为它写一段人设提示词即可对话</Text>}
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
            {custom.map((a) => (
              <div key={a.id} style={{ position: 'relative' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => openCustom(a)}
                  onKeyDown={(e) => e.key === 'Enter' && openCustom(a)}
                  style={{
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 16,
                    padding: '16px 16px 14px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    height: '100%',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        background: token.colorPrimaryBg,
                        color: token.colorPrimary,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: 15,
                        flex: 'none',
                      }}
                    >
                      {a.name.slice(0, 1)}
                    </div>
                    <Text strong style={{ fontSize: 15, flex: 1 }} ellipsis>{a.name}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12.5, lineHeight: '19px', flex: 1 }} ellipsis={{ tooltip: a.description }}>
                    {a.description || '（无简介）'}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    人设：{a.systemPrompt.slice(0, 24)}{a.systemPrompt.length > 24 ? '…' : ''}
                  </Text>
                </div>
                {/* 删除控件置于可点击卡片之外：Popconfirm 弹层经 portal 渲染，React 事件沿组件树冒泡，放卡片内会触发跳转 */}
                <Popconfirm
                  title="删除该自建智能体？"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => removeCustom(a.id)}
                >
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}
                  />
                </Popconfirm>
              </div>
            ))}
          </div>
        )
      ) : visible.length === 0 ? (
        <Empty description="该分类下暂无智能体" style={{ marginTop: 64 }} />
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

      <Modal
        title="新建智能体"
        open={createOpen}
        onOk={() => void submitCreate()}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 12 }}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入智能体名称' }, { max: 30 }]}
          >
            <Input placeholder="例如：门店报价话术助手" maxLength={30} />
          </Form.Item>
          <Form.Item name="description" label="一句话简介（选填）" rules={[{ max: 60 }]}>
            <Input placeholder="卡片上展示给同事看" maxLength={60} />
          </Form.Item>
          <Form.Item
            name="systemPrompt"
            label="人设提示词（对话时作为系统指令注入模型）"
            rules={[{ required: true, message: '请描述这个智能体是谁、要做什么' }, { min: 10, message: '至少 10 个字，写清楚角色与输出要求' }]}
          >
            <Input.TextArea
              rows={4}
              maxLength={2000}
              showCount
              placeholder="例如：你是智能家居门店的报价话术助手。面对客户砍价，给出三档应对话术：守住价格、赠送服务、限时权益。口语化，中文，每条不超过 60 字。"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
