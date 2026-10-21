import {
  AimOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../store/AuthContext';
import { pageContainerStyle } from '../theme/tokens';

const { Text, Paragraph } = Typography;

interface BenchmarkAccount {
  id: string;
  platform: string;
  accountName: string;
  homeUrl: string;
  tags: string;
  note: string;
  enabled: boolean;
  contentCount: number;
  createdAt: string;
}

interface FieldSpec {
  key: string;
  label: string;
  type: string;
  required: boolean;
  note: string;
  example: string;
  baseline: boolean;
  maxLength?: number;
}

interface SortField {
  key: string;
  label: string;
  desc: string;
}

interface HotRules {
  windowDays: number;
  perAccountLimit: number;
  submitLimit: number;
  formula: string;
  decayHalfLifeDays: number;
}

interface CollectSpec {
  version: string;
  title: string;
  intro: string;
  accounts: { accountId: string; platform: string; accountName: string; homeUrl: string; tags: string; note: string }[];
  fields: FieldSpec[];
  hotRules: HotRules;
  sortFields: SortField[];
  retentionDays: number;
  rules: string[];
  jsonExample: unknown;
  submit: { method: string; path: string; auth: string; bodyShape: string };
}

interface ContentRow {
  id: string;
  accountId: string;
  accountName: string;
  platform: string;
  title: string;
  text: string;
  sourceUrl: string;
  publishedAt: string | null;
  stats: string;
  hotScore: number;
  topics: string;
  collectedAt: string;
}

interface GapItem {
  title: string;
  why: string;
  action: string;
}

interface Insight {
  id: string;
  accountId: string;
  accountName: string;
  summary: string;
  analysis: {
    style?: { contentTypes?: string; hooks?: string; rhythm?: string; tone?: string; visual?: string; topics?: string };
    scenes?: { scene: string; ourCategory: string; evidence: string }[];
    products?: { mentioned: string; ourMatch: string; covered: string }[];
    sellingPoints?: string[];
    structure?: { step: string; seconds: string; what: string }[];
  };
  gaps: GapItem[];
  sampleSize: number;
  createdAt: string;
}

interface AccountForm {
  platform: string;
  accountName: string;
  homeUrl: string;
  tags?: string;
  note?: string;
  enabled?: boolean;
}

/** 触发一次分析可能要跑模型，给足超时（与后端 120s 对齐并留余量） */
const ANALYZE_TIMEOUT_MS = 300_000;

function statOf(raw: string): { play: number; like: number; comment: number; collect: number; share: number } {
  try {
    const s = JSON.parse(raw) as Record<string, number>;
    return {
      play: s.play ?? 0,
      like: s.like ?? 0,
      comment: s.comment ?? 0,
      collect: s.collect ?? 0,
      share: s.share ?? 0,
    };
  } catch {
    return { play: 0, like: 0, comment: 0, collect: 0, share: 0 };
  }
}

function downloadText(filename: string, text: string, mime = 'application/json;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Benchmark(): ReactNode {
  const { message } = AntApp.useApp();
  const { user } = useAuth();
  const canWrite = user?.memberships.some((m) => m.permissions.includes('benchmark:write')) ?? false;

  const [tab, setTab] = useState('accounts');
  const [accounts, setAccounts] = useState<BenchmarkAccount[]>([]);
  const [spec, setSpec] = useState<CollectSpec | null>(null);
  const [contents, setContents] = useState<ContentRow[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [sortBy, setSortBy] = useState('hotScore');
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<BenchmarkAccount | null>(null);
  const [form] = Form.useForm<AccountForm>();

  const loadAccounts = useCallback(async (): Promise<void> => {
    const res = await api<{ accounts: BenchmarkAccount[] }>('/api/benchmark/accounts');
    setAccounts(res.accounts);
  }, []);

  const loadSpec = useCallback(async (): Promise<void> => {
    const res = await api<CollectSpec>('/api/benchmark/collect-spec');
    setSpec(res);
  }, []);

  const loadContents = useCallback(async (): Promise<void> => {
    const res = await api<{ contents: ContentRow[] }>(`/api/benchmark/contents?sortBy=${sortBy}&limit=100`);
    setContents(res.contents);
  }, [sortBy]);

  const loadInsights = useCallback(async (): Promise<void> => {
    const res = await api<{ insights: Insight[] }>('/api/benchmark/insights');
    setInsights(res.insights);
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await Promise.all([loadAccounts(), loadSpec(), loadContents(), loadInsights()]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadAccounts, loadSpec, loadContents, loadInsights, message]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadContents().catch((e: Error) => message.error(e.message));
  }, [loadContents, message]);

  const openEdit = (row: BenchmarkAccount | null): void => {
    setEditing(row);
    form.setFieldsValue({
      platform: row?.platform ?? '',
      accountName: row?.accountName ?? '',
      homeUrl: row?.homeUrl ?? '',
      tags: row?.tags ?? '',
      note: row?.note ?? '',
      enabled: row?.enabled ?? true,
    });
    setEditOpen(true);
  };

  const save = async (): Promise<void> => {
    const v = await form.validateFields();
    try {
      if (editing) {
        await api(`/api/benchmark/accounts/${editing.id}`, { method: 'PATCH', body: JSON.stringify(v) });
        message.success('已保存');
      } else {
        await api('/api/benchmark/accounts', { method: 'POST', body: JSON.stringify(v) });
        message.success('已添加对标账号');
      }
      setEditOpen(false);
      await loadAccounts();
      await loadSpec();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/benchmark/accounts/${id}`, { method: 'DELETE' });
      message.success('已删除对标账号及其采集内容');
      await loadAll();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const analyze = async (accountId?: string): Promise<void> => {
    setAnalyzing(true);
    try {
      const res = await api<{ results: { accountName: string; sampleSize: number; gapCount: number; error?: string }[] }>(
        '/api/benchmark/analyze',
        { method: 'POST', body: JSON.stringify({ accountId, topN: 30 }), timeoutMs: ANALYZE_TIMEOUT_MS },
      );
      const ok = res.results.filter((r) => !r.error);
      const failed = res.results.filter((r) => r.error);
      if (ok.length > 0) message.success(`已分析 ${ok.length} 个对标账号，结论进了知识库`);
      if (failed.length > 0) {
        message.warning(`${failed.length} 个账号没分析成功：${failed.map((f) => `${f.accountName}（${f.error}）`).join('、')}`);
      }
      await loadInsights();
      await loadAccounts();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const downloadSpec = (): void => {
    if (!spec) return;
    downloadText('benchmark-collect-spec.json', JSON.stringify(spec, null, 2));
    message.success('契约已下载，把这份文件交给你的 Agent');
  };

  const accountColumns = [
    {
      title: '账号',
      dataIndex: 'accountName',
      render: (_: string, r: BenchmarkAccount) => (
        <Space direction="vertical" size={0}>
          <Text strong>{r.accountName}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.platform}
          </Text>
        </Space>
      ),
    },
    {
      title: '主页链接',
      dataIndex: 'homeUrl',
      render: (v: string) => (
        <Tooltip title={v}>
          <Text style={{ fontSize: 12 }} ellipsis>
            {v}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '分组标签',
      dataIndex: 'tags',
      render: (v: string) =>
        v ? (
          <Space size={4} wrap>
            {v
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
              .map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
          </Space>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: '已采集',
      dataIndex: 'contentCount',
      width: 90,
      render: (v: number) => (v > 0 ? `${v} 条` : <Text type="secondary">未采集</Text>),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      key: 'ops',
      width: 160,
      render: (_: unknown, r: BenchmarkAccount) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这个对标账号？"
            description="它的采集内容与分析结果会一并删除"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(r.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const contentColumns = [
    {
      title: '内容',
      dataIndex: 'title',
      render: (v: string, r: ContentRow) => (
        <Space direction="vertical" size={0} style={{ maxWidth: 420 }}>
          <Text strong ellipsis>
            {v}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {r.text}
          </Text>
        </Space>
      ),
    },
    { title: '账号', dataIndex: 'accountName', width: 140 },
    {
      title: '热度分',
      dataIndex: 'hotScore',
      width: 90,
      render: (v: number) => <Tag color="blue">{v.toFixed(1)}</Tag>,
    },
    {
      title: '互动',
      key: 'stats',
      width: 200,
      render: (_: unknown, r: ContentRow) => {
        const s = statOf(r.stats);
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            播放 {s.play} · 赞 {s.like} · 评 {s.comment} · 藏 {s.collect} · 转 {s.share}
          </Text>
        );
      },
    },
    {
      title: '发布',
      dataIndex: 'publishedAt',
      width: 110,
      render: (v: string | null) => (v ? new Date(v).toLocaleDateString('zh-CN') : <Text type="secondary">未知</Text>),
    },
  ];

  const specItems = useMemo(
    () => [
      {
        key: 'accounts',
        label: `对标账号（${accounts.length}）`,
        children: (
          <Card
            title="我们盯谁"
            extra={
              canWrite ? (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit(null)}>
                  新增对标账号
                </Button>
              ) : null
            }
          >
            <Paragraph type="secondary" style={{ marginTop: 0 }}>
              平台名自己填（不预设任何平台），账号主页链接交给带浏览器能力的 Agent 去定位。
              停用的账号不参与采集与分析。
            </Paragraph>
            <Table<BenchmarkAccount>
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={accounts}
              columns={accountColumns}
              pagination={false}
              locale={{ emptyText: <Empty description="还没有对标账号。先加一个你想盯的账号" /> }}
            />
          </Card>
        ),
      },
      {
        key: 'spec',
        label: '采集契约',
        children: (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card
              title="怎么让 Agent 干活"
              extra={
                <Button icon={<DownloadOutlined />} onClick={downloadSpec} disabled={!spec}>
                  下载契约（给 Agent）
                </Button>
              }
            >
              <List
                size="small"
                dataSource={[
                  '把下载的契约文件交给你的 Agent（它自带浏览器能力，能登录平台）',
                  'Agent 用浏览器找到契约里列出的账号，抓它们最近热门的内容元数据',
                  'Agent 调 POST /api/benchmark/contents 把采到的内容提交回来',
                  '回到「画像与差距」点「开始分析」，系统把内容映射到我们的业务，给出风格画像与差距清单',
                  '想每天自动：让 Agent 设一个每天的定时任务，按契约采集并提交一次',
                ]}
                renderItem={(t, i) => (
                  <List.Item>
                    <Text>
                      {i + 1}. {t}
                    </Text>
                  </List.Item>
                )}
              />
              <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
                采集动作在 Agent 侧完成——服务端不装无头浏览器，也不做定时调度。
                契约里写清了要采哪些字段、怎么算热门、怎么提交，Agent 照着做就行。
              </Paragraph>
            </Card>

            <Card title="采集字段">
              <Table<FieldSpec>
                rowKey="key"
                size="small"
                dataSource={spec?.fields ?? []}
                pagination={false}
                columns={[
                  { title: '字段', dataIndex: 'key', width: 130, render: (v: string, r) => (
                    <Space size={4}>
                      <Text code>{v}</Text>
                      {r.required ? <Tag color="red">必填</Tag> : null}
                    </Space>
                  ) },
                  { title: '含义', dataIndex: 'label', width: 110 },
                  {
                    title: '采集要点',
                    dataIndex: 'note',
                    render: (v: string, r) => (
                      <Space direction="vertical" size={0}>
                        <Text style={{ fontSize: 12 }}>{v}</Text>
                        {r.baseline ? (
                          <Tag color="cyan" style={{ fontSize: 11 }}>
                            同业基线字段
                          </Tag>
                        ) : (
                          <Tag style={{ fontSize: 11 }}>可选增强</Tag>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            </Card>

            <Card title="热门判定与提交规则">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="热度公式">
                  <Text code>{spec?.hotRules.formula ?? ''}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="时间窗">{spec ? `${spec.hotRules.windowDays} 天内发布` : '-'}</Descriptions.Item>
                <Descriptions.Item label="每账号条数上限">{spec ? `${spec.hotRules.perAccountLimit} 条` : '-'}</Descriptions.Item>
                <Descriptions.Item label="单次提交上限">{spec ? `${spec.hotRules.submitLimit} 条` : '-'}</Descriptions.Item>
                <Descriptions.Item label="数据保留期">{spec ? `${spec.retentionDays} 天` : '-'}</Descriptions.Item>
                <Descriptions.Item label="排序维度">
                  <Space size={4} wrap>
                    {(spec?.sortFields ?? []).map((f) => (
                      <Tooltip key={f.key} title={f.desc}>
                        <Tag>{f.label}</Tag>
                      </Tooltip>
                    ))}
                  </Space>
                </Descriptions.Item>
              </Descriptions>
              <List
                size="small"
                style={{ marginTop: 12 }}
                dataSource={spec?.rules ?? []}
                renderItem={(t, i) => (
                  <List.Item>
                    <Text style={{ fontSize: 13 }}>
                      {i + 1}. {t}
                    </Text>
                  </List.Item>
                )}
              />
            </Card>
          </Space>
        ),
      },
      {
        key: 'contents',
        label: `热门内容（${contents.length}）`,
        children: (
          <Card
            title="采集到的内容"
            extra={
              <Select
                size="small"
                value={sortBy}
                style={{ width: 150 }}
                onChange={(v) => setSortBy(v)}
                options={(spec?.sortFields ?? [{ key: 'hotScore', label: '综合热度' }]).map((f) => ({
                  value: f.key,
                  label: f.label,
                }))}
              />
            }
          >
            <Table<ContentRow>
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={contents}
              columns={contentColumns}
              pagination={{ pageSize: 20 }}
              locale={{
                emptyText: (
                  <Empty description="还没有采集到内容。先在「对标账号」配好账号，再让 Agent 按契约采集并提交" />
                ),
              }}
            />
          </Card>
        ),
      },
      {
        key: 'insights',
        label: `画像与差距（${insights.length}）`,
        children: (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card
              title="AI 映射分析"
              extra={
                canWrite ? (
                  <Space>
                    <Button onClick={() => void analyze()} loading={analyzing} icon={<ExperimentOutlined />}>
                      分析全部账号
                    </Button>
                    <Button
                      type="primary"
                      onClick={() => void analyze(insights[0]?.accountId)}
                      loading={analyzing}
                      disabled={insights.length === 0}
                      icon={<RobotOutlined />}
                    >
                      重分析最近一个
                    </Button>
                  </Space>
                ) : null
              }
            >
              <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0 }}>
                分析把对标的热门内容映射到我们的品类、产品与卖点，产出风格画像、可复用的内容结构，
                以及我们与它的差距。结论会同时写进知识库，之后跟智能体对话时它会参考这些内容。
              </Paragraph>
            </Card>

            {insights.length === 0 ? (
              <Card>
                <Empty description="还没有分析结果。采集到内容后点上面的「分析全部账号」" />
              </Card>
            ) : (
              insights.map((ins) => {
                const style = ins.analysis?.style ?? {};
                const scenes = ins.analysis?.scenes ?? [];
                const selling = ins.analysis?.sellingPoints ?? [];
                const structure = ins.analysis?.structure ?? [];
                const products = ins.analysis?.products ?? [];
                return (
                  <Card
                    key={ins.id}
                    title={
                      <Space>
                        <AimOutlined />
                        <span>{ins.accountName}</span>
                        <Tag>样本 {ins.sampleSize} 条</Tag>
                      </Space>
                    }
                    extra={<Text type="secondary">{new Date(ins.createdAt).toLocaleString('zh-CN')}</Text>}
                  >
                    {ins.summary ? (
                      <Paragraph strong style={{ marginTop: 0 }}>
                        {ins.summary}
                      </Paragraph>
                    ) : null}

                    <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
                      {style.contentTypes ? (
                        <Descriptions.Item label="常见内容类型">{style.contentTypes}</Descriptions.Item>
                      ) : null}
                      {style.hooks ? <Descriptions.Item label="开头钩子">{style.hooks}</Descriptions.Item> : null}
                      {style.rhythm ? <Descriptions.Item label="结构节奏">{style.rhythm}</Descriptions.Item> : null}
                      {style.tone ? <Descriptions.Item label="语气人称">{style.tone}</Descriptions.Item> : null}
                      {style.visual ? <Descriptions.Item label="画面呈现">{style.visual}</Descriptions.Item> : null}
                      {style.topics ? <Descriptions.Item label="话题方向">{style.topics}</Descriptions.Item> : null}
                    </Descriptions>

                    {scenes.length > 0 ? (
                      <>
                        <Text strong>场景映射到我们的品类</Text>
                        <Table
                          rowKey={(r) => r.scene}
                          size="small"
                          pagination={false}
                          style={{ marginBottom: 12 }}
                          dataSource={scenes}
                          columns={[
                            { title: '对标在讲的场景', dataIndex: 'scene' },
                            { title: '我们的品类', dataIndex: 'ourCategory', render: (v: string) => v || <Text type="secondary">待定</Text> },
                            { title: '依据', dataIndex: 'evidence' },
                          ]}
                        />
                      </>
                    ) : null}

                    {selling.length > 0 ? (
                      <>
                        <Text strong>它反复强调的卖点</Text>
                        <Space size={4} wrap style={{ marginBottom: 12 }}>
                          {selling.map((p) => (
                            <Tag key={p}>{p}</Tag>
                          ))}
                        </Space>
                      </>
                    ) : null}

                    {structure.length > 0 ? (
                      <>
                        <Text strong>可复用的内容结构</Text>
                        <List
                          size="small"
                          style={{ marginBottom: 12 }}
                          dataSource={structure}
                          renderItem={(s, i) => (
                            <List.Item>
                              <Text>
                                {i + 1}. {s.step}
                                {s.seconds ? `（${s.seconds}）` : ''}：{s.what}
                              </Text>
                            </List.Item>
                          )}
                        />
                      </>
                    ) : null}

                    {products.length > 0 ? (
                      <>
                        <Text strong>产品对照</Text>
                        <Table
                          rowKey={(r) => r.mentioned}
                          size="small"
                          pagination={false}
                          style={{ marginBottom: 12 }}
                          dataSource={products}
                          columns={[
                            { title: '对标提到', dataIndex: 'mentioned' },
                            { title: '我们的对应', dataIndex: 'ourMatch', render: (v: string) => v || <Text type="secondary">无</Text> },
                            {
                              title: '是否覆盖',
                              dataIndex: 'covered',
                              width: 90,
                              render: (v: string) =>
                                v === 'yes' ? (
                                  <Tag color="green">已覆盖</Tag>
                                ) : v === 'no' ? (
                                  <Tag color="red">没覆盖</Tag>
                                ) : (
                                  <Tag>不确定</Tag>
                                ),
                            },
                          ]}
                        />
                      </>
                    ) : null}

                    {ins.gaps.length > 0 ? (
                      <>
                        <Text strong>我们与它的差距</Text>
                        <List
                          size="small"
                          style={{ marginTop: 8 }}
                          dataSource={ins.gaps}
                          renderItem={(g) => (
                            <List.Item>
                              <Space direction="vertical" size={0}>
                                <Text strong>{g.title}</Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {g.why}
                                </Text>
                                <Text style={{ fontSize: 12, color: '#1677ff' }}>
                                  建议：{g.action}
                                </Text>
                              </Space>
                            </List.Item>
                          )}
                        />
                      </>
                    ) : null}
                  </Card>
                );
              })
            )}
          </Space>
        ),
      },
    ],
    [accounts, spec, contents, insights, loading, sortBy, canWrite, analyzing, message],
  );

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="对标情报"
        description="配置对标账号，采集它们的热门内容，映射到我们的业务，产出风格画像与差距清单"
      />
      <Tabs activeKey={tab} onChange={setTab} items={specItems} />
      <Modal
        title={editing ? `编辑「${editing.accountName}」` : '新增对标账号'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="platform" label="平台" rules={[{ required: true, message: '请填写平台' }]}>
            <Input placeholder="自己填，比如你想盯的那个内容平台的名称" maxLength={30} />
          </Form.Item>
          <Form.Item name="accountName" label="账号名" rules={[{ required: true, message: '请填写账号名' }]}>
            <Input placeholder="对标账号的名称" maxLength={60} />
          </Form.Item>
          <Form.Item
            name="homeUrl"
            label="主页链接"
            rules={[{ required: true, message: '请填写主页链接' }]}
            extra="Agent 会用它登录并定位这个账号"
          >
            <Input placeholder="账号主页地址" maxLength={300} />
          </Form.Item>
          <Form.Item name="tags" label="分组标签" extra="逗号分隔，方便按主题筛">
            <Input placeholder="智能家居,照明,讲解" maxLength={200} />
          </Form.Item>
          <Form.Item name="note" label="备注" extra="记一下这个账号为什么值得对标">
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Select
              options={[
                { value: true, label: '启用（参与采集与分析）' },
                { value: false, label: '停用' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
