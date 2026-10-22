import { DeleteOutlined, FireFilled, PlusOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Dropdown, Empty, Form, Grid, Input, Modal, Popconfirm, Switch, Tooltip, Typography, theme } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AGENT_CATEGORIES, SEED_AGENTS, type AgentDef } from '../data/agents';
import { listCustomAgents, createCustomAgent, deleteCustomAgent, type CustomAgent } from '../data/customAgents';
import { useAuth } from '../store/AuthContext';

const { Text, Title } = Typography;

type SortKey = 'default' | 'usage' | 'name' | 'saved';

const SORT_LABELS: Record<SortKey, string> = {
  saved: '常用优先',
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

/**
 * 收藏（「常用」）的存储键按账号分。
 * 多账号共用浏览器很常见，不分键就会出现「我在这台机器上把别人的常用改了」。
 * 语义：只存本机、换设备不同步，所以界面上要如实说明。
 */
const savedKey = (accountId: string): string => `agent_saved_v1:${accountId}`;

const readSaved = (accountId: string): Set<string> => {
  try {
    const raw = JSON.parse(localStorage.getItem(savedKey(accountId)) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
};

/** 自建智能体与预置智能体共用一套收藏集合：预置用 key，自建统一加 custom_ 前缀避免撞号 */
const saveIdOf = (a: { key?: string; id?: string }): string => (a.key as string) ?? `custom_${a.id}`;

/**
 * 预置智能体的「启用/停用」是本机偏好，和收藏同语义：按账号分键存 localStorage。
 * 之前只改 React 内存，刷新即回默认值——用户关掉一个智能体，隔天又冒出来。
 * 存的值只列出「被显式关掉」的 key，其余按 SEED_AGENTS 的默认启用状态，
 * 这样以后给 SEED_AGENTS 新增智能体时不会被一份旧名单误伤。
 */
const disabledKey = (accountId: string): string => `agent_disabled_v1:${accountId}`;

const readDisabled = (accountId: string): Set<string> => {
  try {
    const raw = JSON.parse(localStorage.getItem(disabledKey(accountId)) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
};

export function AgentMarket(): ReactNode {
  const { message } = AntApp.useApp();
  const { user } = useAuth();
  const accountId = user?.id ?? 'anonymous';
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
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

  // 换账号时重新读收藏：同一台机器上两个账号的「常用」不该是同一份
  useEffect(() => {
    setSaved(readSaved(accountId));
    const off = readDisabled(accountId);
    setAgents((prev) => prev.map((a) => ({ ...a, enabled: a.enabled && !off.has(a.key) })));
  }, [accountId]);

  const toggleSave = (id: string): void => {
    const next = new Set(saved);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSaved(next);
    try {
      localStorage.setItem(savedKey(accountId), JSON.stringify([...next]));
    } catch {
      // 不静默降级：用户以为存下了，下次打开发现没了，比当场报错更气人
      message.warning('浏览器未允许保存，常用设置仅在本次浏览中有效。');
    }
  };

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
    if (category === '常用') {
      // 「常用」是虚拟分类：只看被收藏的预置智能体
      list = list.filter((a) => saved.has(saveIdOf(a)));
    } else if (category !== '全部' && category !== '我的智能体') {
      list = list.filter((a) => a.category === category);
    }
    if (sort === 'usage') list = [...list].sort((a, b) => b.usage - a.usage);
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    // 常用优先：收藏的排前面，其余保持原顺序
    if (sort === 'saved') list = [...list].sort((a, b) => Number(saved.has(saveIdOf(b))) - Number(saved.has(saveIdOf(a))));
    return list;
  }, [agents, category, sort, saved]);

  const toggle = (key: string, enabled: boolean): void => {
    setAgents((prev) => prev.map((a) => (a.key === key ? { ...a, enabled } : a)));
    // 只落「被关掉的」，开着的走 SEED_AGENTS 默认值，新增智能体不会被旧名单压成停用
    const off = new Set(agents.filter((a) => !a.enabled && a.key !== key).map((a) => a.key));
    if (!enabled) off.add(key);
    try {
      localStorage.setItem(disabledKey(accountId), JSON.stringify([...off]));
    } catch {
      message.warning('浏览器未允许保存，启用状态仅在本次浏览中有效。');
    }
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
        {[...AGENT_CATEGORIES, '常用'].map((c) => {
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
                  {/* 收藏开关在可点击卡片内部，必须 stopPropagation，否则点开关会同时跳转进对话 */}
                  <div
                    role="switch"
                    aria-checked={saved.has(saveIdOf(a))}
                    aria-label={`${a.name}：加入常用`}
                    tabIndex={0}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleSave(saveIdOf(a));
                      }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, cursor: 'pointer', width: 'fit-content' }}
                  >
                    <Switch
                      size="small"
                      checked={saved.has(saveIdOf(a))}
                      onChange={() => toggleSave(saveIdOf(a))}
                    />
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {saved.has(saveIdOf(a)) ? '已加入常用' : '加入常用'}
                    </Text>
                  </div>
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
        <Empty
          // 空态分两种并各给引导：只写「暂无」用户不知道下一步该做什么
          description={
            category === '常用' ? (
              <Text type="secondary">
                还没有常用智能体。打开卡片底部的「加入常用」开关，把常用的放在一起。
              </Text>
            ) : (
              <Text type="secondary">该分类下暂无智能体，试试其他分类</Text>
            )
          }
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
                  {a.usage > 0 ? (
                    <Text type="secondary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FireFilled style={{ color: '#F5533D' }} /> 使用热度 {a.usage} 次
                    </Text>
                  ) : (
                    /* 次数为 0 就别写「0 次」—— 那不是使用量，是没数据。 */
                    <Text type="secondary" style={{ fontSize: 12 }}>内置智能体</Text>
                  )}
                  <div style={{ flex: 1 }} />
                  {/* 「常用」分类筛的就是预置智能体，这里不给入口，那个分类就永远是空的 */}
                  <Tooltip title={saved.has(a.key) ? '取消常用' : '加入常用'}>
                    <Button
                      size="small"
                      type="text"
                      aria-label={`${a.name}：加入常用`}
                      aria-pressed={saved.has(a.key)}
                      icon={saved.has(a.key) ? <StarFilled style={{ color: '#FAAD14' }} /> : <StarOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSave(a.key);
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={a.enabled ? '点此停用' : '点此启用'}>
                    <Switch
                      size="small"
                      checked={a.enabled}
                      onClick={(_, e) => e.stopPropagation()}
                      onChange={(checked) => {
                        toggle(a.key, checked);
                      }}
                    />
                  </Tooltip>
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
