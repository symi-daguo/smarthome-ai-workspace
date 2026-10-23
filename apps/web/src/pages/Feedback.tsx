import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Card, Empty, Form, Grid, Input, Popconfirm, Segmented, Select, Space, Tag, Typography, theme } from 'antd';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { clearContext, formatContext, getLastError, snapshot } from '../lib/errorContext';
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
  const { token } = theme.useToken();
  // 上下文为纯内存采集，路由/操作变化时刷新即可
  const [ctxTick, setCtxTick] = useState(0);
  const [contextOn, setContextOn] = useState(true);
  const [lastErr, setLastErr] = useState<string | null>(null);
  const ctx = snapshot();
  const ctxCount = ctx.failedRequests.length + ctx.actions.length;
  useEffect(() => { setCtxTick((n) => n + 1); setLastErr(getLastError()); }, [tickets.length]);

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

  /**
   * 「提交到作者仓库」。
   *
   * 工单是**租户内**的：本租户管理员看得到，但作者看不到（每个部署是独立租户，
   * 作者手里没有跨租户工单视图）。这一步把同一条内容预填成作者仓库里的 issue，
   * 作者才能在仓库 Issues 里集中处理所有部署提上来的问题。
   *
   * 先同步开窗再取链接：await 之后再 window.open 会被浏览器的弹窗拦截器挡掉。
   */
  const openIssue = async (id: string): Promise<void> => {
    const w = window.open('', '_blank');
    try {
      const r = await api<{ url: string; repo: string }>(`/api/feedback/${id}/issue-link`);
      if (w) {
        w.location.href = r.url;
      } else {
        window.open(r.url, '_blank', 'noopener');
      }
      message.info('已打开作者仓库的新建 issue 页面：标题与摘要已预填，提交前请删掉地址、预算等敏感信息（issue 在公开仓库里）');
    } catch (e) {
      w?.close();
      message.error(e instanceof Error ? e.message : '生成提交链接失败');
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: { category: string; title: string; detail?: string }): Promise<void> => {
    setSubmitting(true);
    try {
      const ctx = formatContext();
      await api('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          detail: contextOn
            ? [values.detail, '', '--- 自动采集的上下文 ---', formatContext()].filter(Boolean).join('\n')
            : values.detail,
        }),
      });
      clearContext();
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
        description="生成失败、卡住、不会用，或任何使用建议，都可以提交在这里，处理进度会同步更新。这里是租户内的工单；要让作者本人看到并集中处理，点记录右侧的「提交到作者仓库」，会带着标题与摘要打开作者仓库的新建 issue 页面（issue 在公开仓库，提交前请删掉地址、预算等敏感信息）。"
        extra={<Button onClick={() => void load()} loading={loading}>刷新</Button>}
      />

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
        <Card title="提交反馈" style={stacked ? { width: '100%' } : { flex: '0 0 380px', width: 380 }}>
          <Form layout="vertical" onFinish={(v) => void submit(v)} initialValues={{ category: 'bug' }}>
            <Form.Item name="category" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
              <Select options={Object.entries(CATEGORY).map(([value, v]) => ({ value, label: v.label }))} />
            </Form.Item>
            <Form.Item name="title" label="一句话描述" rules={[{ required: true, message: '请填写问题标题' }, { min: 2, max: 80, message: '2-80 字' }]}>
              <Input placeholder="例如：生图一直转圈不出结果" maxLength={80} />
            </Form.Item>
            <Form.Item name="detail" label="详细情况（可选）">
              <Input.TextArea rows={4} placeholder="什么时间、哪个板块、做了什么操作、期望结果是什么。下方会自动附上操作轨迹与失败请求，你不用重复描述。" maxLength={1000} />
            </Form.Item>
            {/* 自动上下文：用户不必复述操作路径；同时允许一键丢弃，避免混入无关信息 */}
            <div
              style={{
                marginTop: -4, marginBottom: 14, padding: '10px 12px', borderRadius: 10,
                background: token.colorFillQuaternary, fontSize: 12.5, lineHeight: 1.75,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text type="secondary">已自动采集：{ctxCount}</Text>
                {ctxCount > 0 && (
                  <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setContextOn(false)}>
                    不附带
                  </Button>
                )}
              </div>
              {contextOn && ctxCount > 0 && (
                <>
                  <div>· 页面：{ctx.route}</div>
                  {ctx.failedRequests.length > 0 && (
                    <div>· {ctx.failedRequests.length} 个失败请求：{ctx.failedRequests.map((r) => r.path).join('、')}</div>
                  )}
                  {lastErr && <div style={{ color: token.colorError }}>· 最近一次报错：{lastErr}</div>}
                  {ctx.actions.length > 0 && (
                    <div>· 操作轨迹：{ctx.actions.slice(-3).map((a) => a.text).join(' → ')}</div>
                  )}
                </>
              )}
            </div>
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
                        <Card size="small" style={{ background: token.colorSuccessBg, borderColor: token.colorSuccessBorder }} styles={{ body: { padding: 10 } }}>
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
                        <Button size="small" onClick={() => void openIssue(t.id)}>
                          提交到作者仓库
                        </Button>
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