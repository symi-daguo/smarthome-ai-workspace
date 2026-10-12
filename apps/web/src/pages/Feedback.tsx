import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Card, Empty, Form, Grid, Input, Popconfirm, Segmented, Select, Space, Tag, Typography } from 'antd';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { pageContainerStyle } from '../theme/tokens';

const { Text, Paragraph } = Typography;

type Status = 'open' | 'processing' | 'resolved' | 'closed';

interface Ticket {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: Status;
  reply: string;
  repliedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const CATEGORY: Record<string, { label: string; color: string }> = {
  bug: { label: '故障申报', color: 'red' },
  feature: { label: '功能建议', color: 'blue' },
  other: { label: '其他', color: 'default' },
};

const STATUS: Record<Status, { label: string; color: string }> = {
  open: { label: '待处理', color: 'orange' },
  processing: { label: '处理中', color: 'blue' },
  resolved: { label: '已解决', color: 'green' },
  closed: { label: '已关闭', color: 'default' },
};

/** 状态机：resolved 只能从 open/processing 进，closed 只能从 resolved 进 */
const NEXT_STATUS: Record<Status, Status[]> = {
  open: ['processing', 'resolved'],
  processing: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

/**
 * 问题反馈（百宝箱「人工与定制服务」工具）：
 * 用户提交问题并跟踪处理进度；管理员在同一页回复与流转状态。
 * 提交后即出现在列表顶部，状态变化实时可见，不用再靠人工问。
 */
export function Feedback(): ReactNode {
  const { message } = AntApp.useApp();
  const { user } = useAuth();
  const isAdmin = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage')) ?? false;
  // 窄屏（平板竖屏 / 手机）改为上下堆叠，避免固定宽度导致横向溢出
  const screens = Grid.useBreakpoint();
  const stacked = !(screens.md ?? false);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTickets(await api<Ticket[]>('/api/feedback'));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: { category: string; title: string; detail?: string }): Promise<void> => {
    setSubmitting(true);
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify(values) });
      message.success('反馈已提交，我们会在「问题反馈」里同步处理进度');
      values.title = '';
      values.detail = '';
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const patch = async (id: string, body: { status?: Status; reply?: string }): Promise<void> => {
    try {
      await api(`/api/feedback/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
      message.success('已更新');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败');
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/feedback/${id}`, { method: 'DELETE' });
      await load();
      message.success('已删除');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const shown = filter === 'open' ? tickets.filter((t) => t.status === 'open' || t.status === 'processing') : tickets;

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="问题反馈"
        description="生成失败、卡住、不会用，或任何使用建议，都可以提交在这里，处理进度会同步更新"
        extra={<Button onClick={() => void load()} loading={loading}>刷新</Button>}
      />

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Card title="提交反馈" style={stacked ? { width: '100%' } : { flex: '0 0 380px', width: 380 }}>
          <Form layout="vertical" onFinish={(v) => void submit(v)} initialValues={{ category: 'bug' }}>
            <Form.Item name="category" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
              <Select options={Object.entries(CATEGORY).map(([value, v]) => ({ value, label: v.label }))} />
            </Form.Item>
            <Form.Item name="title" label="一句话描述" rules={[{ required: true, message: '请填写问题标题' }, { min: 2, max: 80, message: '2-80 字' }]}>
              <Input placeholder="例如：生图一直转圈不出结果" maxLength={80} />
            </Form.Item>
            <Form.Item name="detail" label="详细情况（可选）">
              <Input.TextArea rows={5} placeholder="什么时间、哪个板块、做了什么操作、期望结果是什么。带上这些我们排查更快。" maxLength={1000} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} block>提交反馈</Button>
          </Form>
        </Card>

        <Card
          style={stacked ? { width: '100%' } : { flex: '1 1 520px', minWidth: 320 }}
          title={`反馈记录（${shown.length}）`}
          extra={<Segmented size="small" options={[{ label: '全部', value: 'all' }, { label: '处理中', value: 'open' }]} value={filter} onChange={(v) => setFilter(v as 'all' | 'open')} />}
        >
          {shown.length === 0 ? (
            <Empty description={loading ? '加载中…' : '还没有反馈记录'} />
          ) : (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {shown.map((t) => {
                const cat = CATEGORY[t.category] ?? { label: t.category, color: 'default' };
                const st = STATUS[t.status] ?? { label: t.status, color: 'default' };
                return (
                  <Card key={t.id} size="small" styles={{ body: { padding: 14 } }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Space wrap>
                        <Tag color={cat.color}>{cat.label}</Tag>
                        <Tag color={st.color}>{st.label}</Tag>
                        <Text strong>{t.title}</Text>
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        提交于 {new Date(t.createdAt).toLocaleString('zh-CN')}
                      </Text>
                      {t.detail && <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{t.detail}</Paragraph>}

                      {t.reply && (
                        <Card size="small" style={{ background: '#F6FFFA', borderColor: '#B7EB8F' }} styles={{ body: { padding: 10 } }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>官方回复{t.repliedBy ? `（${t.repliedBy}）` : ''}</Text>
                          <Paragraph style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{t.reply}</Paragraph>
                        </Card>
                      )}

                      <Space wrap>
                        {isAdmin && (
                          <>
                            <Select
                              size="small"
                              style={{ width: 118 }}
                              value={t.status}
                              options={NEXT_STATUS[t.status].map((s) => ({ value: s, label: `标记为 ${STATUS[s].label}` }))}
                              onChange={(s) => void patch(t.id, { status: s as Status })}
                              placeholder={NEXT_STATUS[t.status].length === 0 ? '流程已结束' : '流转状态'}
                              disabled={NEXT_STATUS[t.status].length === 0}
                            />
                            <Input
                              size="small"
                              style={stacked ? { width: '100%' } : { width: 220 }}
                              placeholder="回复内容"
                              value={replyDraft[t.id] ?? ''}
                              onChange={(e) => setReplyDraft((prev) => ({ ...prev, [t.id]: e.target.value }))}
                            />
                            <Button
                              size="small"
                              onClick={() => void patch(t.id, { reply: replyDraft[t.id] ?? '' })}
                              disabled={!(replyDraft[t.id] ?? '').trim()}
                            >
                              回复
                            </Button>
                          </>
                        )}
                        <Popconfirm title="删除这条反馈？" onConfirm={() => void remove(t.id)}>
                          <Button size="small" danger>删除</Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                  </Card>
                );
              })}
            </Space>
          )}
        </Card>
      </div>
    </div>
  );
}