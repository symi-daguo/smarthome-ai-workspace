import {
  CheckCircleFilled,
  CloudUploadOutlined,
  FileSearchOutlined,
  LinkOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Progress,
  Radio,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  App as AntApp,
  theme,
} from 'antd';
import type { UploadProps } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

const { Text, Paragraph } = Typography;
const { useToken } = theme;

type JobStatus = 'PENDING' | 'EXTRACTING' | 'REVIEWING' | 'CONFIRMED' | 'REJECTED' | 'FAILED';
type Source = 'UPLOAD' | 'URL' | 'TRANSCRIPT';

interface FieldItem {
  id: string;
  key: string;
  label: string;
  value: string;
  required: boolean;
  confidence: number;
}

interface DeficiencyItem {
  id: string;
  fieldKey: string;
  label: string;
  reason: string;
  resolved: boolean;
}

interface JobDetail {
  id: string;
  source: Source;
  sourceRef: string;
  status: JobStatus;
  score: number | null;
  error: string | null;
  createdAt: string;
  document: {
    id: string;
    title: string;
    docType: string;
    content: string;
    confirmed: boolean;
    fields: FieldItem[];
  } | null;
  deficiencies: DeficiencyItem[];
}

interface JobRow {
  id: string;
  source: Source;
  sourceRef: string;
  status: JobStatus;
  score: number | null;
  createdAt: string;
  deficiencies: { id: string }[];
  document: { id: string; title: string; confirmed: boolean; docType: string } | null;
}

interface DocRow {
  id: string;
  title: string;
  docType: string;
  updatedAt: string;
  job: { source: Source; sourceRef: string; score: number | null };
  fields: { key: string; label: string; value: string }[];
}

const STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  PENDING: { label: '排队中', color: 'default' },
  EXTRACTING: { label: '提取中', color: 'processing' },
  REVIEWING: { label: '待确认', color: 'warning' },
  CONFIRMED: { label: '已入库', color: 'success' },
  REJECTED: { label: '已驳回', color: 'default' },
  FAILED: { label: '失败', color: 'error' },
};

const SOURCE_LABEL: Record<Source, string> = {
  UPLOAD: '上传文档',
  URL: '网页抓取',
  TRANSCRIPT: '对话纪要',
};

const DOC_TYPE_OPTIONS = [
  { label: '产品资料', value: 'product' },
  { label: '会议纪要', value: 'meeting' },
  { label: '通用文本', value: 'generic' },
] as const;

export function ContentExtract(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = useToken();
  const [sourceTab, setSourceTab] = useState<'upload' | 'url' | 'transcript'>('upload');
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploadForm] = Form.useForm<{ docType: string }>();
  const [urlForm] = Form.useForm<{ docType: string; url: string }>();
  const [transcriptForm] = Form.useForm<{ docType: string; title?: string; text: string }>();

  const [reviewJob, setReviewJob] = useState<JobDetail | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const [jobList, docList] = await Promise.all([
        api<JobRow[]>('/api/content/extractions'),
        api<DocRow[]>('/api/content/extractions/documents'),
      ]);
      setJobs(jobList);
      setDocs(docList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openReview = async (id: string): Promise<void> => {
    setReviewLoading(true);
    try {
      const detail = await api<JobDetail>(`/api/content/extractions/${id}`);
      setReviewJob(detail);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewLoading(false);
    }
  };

  const submitUpload = async (file: File): Promise<boolean> => {
    const docType = uploadForm.getFieldValue('docType') ?? 'product';
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('docType', docType);
      const job = await api<JobDetail>('/api/content/extractions/upload', { method: 'POST', body: form });
      message.success('提取完成');
      await refresh();
      await openReview(job.id);
      return false;
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const submitUrl = async (values: { docType: string; url: string }): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const job = await api<JobDetail>('/api/content/extractions/url', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      message.success('网页提取完成');
      urlForm.resetFields();
      await refresh();
      await openReview(job.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitTranscript = async (values: { docType: string; title?: string; text: string }): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const job = await api<JobDetail>('/api/content/extractions/transcript', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      message.success('纪要结构化完成');
      transcriptForm.resetFields();
      await refresh();
      await openReview(job.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: '.txt,.md,.csv,.json,.html,.htm,.docx,.xlsx,.pdf',
    multiple: false,
    maxCount: 1,
    beforeUpload: (file) => submitUpload(file),
    onDrop: (e) => e.preventDefault(),
  };

  const jobColumns = [
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (value: Source) => <Tag>{SOURCE_LABEL[value]}</Tag>,
    },
    {
      title: '名称 / 链接',
      dataIndex: 'sourceRef',
      ellipsis: true,
      render: (value: string, row: JobRow) => (
        <Space size={6}>
          <Text>{row.document?.title ?? value}</Text>
          {value !== row.document?.title ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {value}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '质量分',
      dataIndex: 'score',
      width: 90,
      render: (value: number | null) =>
        value === null ? <Text type="secondary">-</Text> : <Text strong>{value}</Text>,
    },
    {
      title: '缺失',
      width: 80,
      render: (_: unknown, row: JobRow) => {
        if (row.status === 'FAILED' || row.status === 'REJECTED' || row.status === 'PENDING') {
          return <Text type="secondary">-</Text>;
        }
        return row.deficiencies.length > 0 ? (
          <Badge count={row.deficiencies.length} color="#faad14" />
        ) : (
          <CheckCircleFilled style={{ color: token.colorSuccess }} />
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: JobStatus) => <Tag color={STATUS_META[value].color}>{STATUS_META[value].label}</Tag>,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: string) => dayjs(value).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      width: 90,
      render: (_: unknown, row: JobRow) => (
        <Button type="link" size="small" onClick={() => void openReview(row.id)}>
          {row.status === 'REVIEWING' ? '去确认' : '查看'}
        </Button>
      ),
    },
  ];

  return (
    <div style={{ width: '100%', paddingBottom: 24 }}>
      <PageHeader
        title="内容提取"
        description="三源输入（上传资料 / 网页抓取 / 对话纪要）→ 字段结构化 → 质量评分 → 缺失确认后入库"
      />

      {error ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 16 }} /> : null}

      <Card style={{ marginBottom: 16 }}>
        <Tabs
          activeKey={sourceTab}
          onChange={(key) => setSourceTab(key as typeof sourceTab)}
          items={[
            {
              key: 'upload',
              label: (
                <Space>
                  <CloudUploadOutlined /> 上传文档
                </Space>
              ),
              children: (
                <Row gutter={24} align="middle">
                  <Col xs={24} md={14}>
                    <Upload.Dragger {...uploadProps} disabled={submitting} style={{ padding: 20 }}>
                      <p className="ant-upload-drag-icon">
                        <CloudUploadOutlined />
                      </p>
                      <p className="ant-upload-text">点击或拖拽文件到此处上传</p>
                      <p className="ant-upload-hint">支持 TXT / MD / DOCX / XLSX / PDF / HTML，单文件不超过 20MB</p>
                    </Upload.Dragger>
                  </Col>
                  <Col xs={24} md={10}>
                    <Form form={uploadForm} layout="vertical" initialValues={{ docType: 'product' }}>
                      <Form.Item name="docType" label="资料类型（决定必需字段校验集）">
                        <Radio.Group optionType="button" buttonStyle="solid" options={DOC_TYPE_OPTIONS as unknown as { label: string; value: string }[]} />
                      </Form.Item>
                      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                        解析与入库分离，上传后立即抽取名称、型号、价格、规格、卖点等字段；无法识别的必需字段将生成待确认项。
                      </Paragraph>
                    </Form>
                  </Col>
                </Row>
              ),
            },
            {
              key: 'url',
              label: (
                <Space>
                  <LinkOutlined /> 网页抓取
                </Space>
              ),
              children: (
                <Form form={urlForm} layout="vertical" onFinish={submitUrl} initialValues={{ docType: 'product' }}>
                  <Form.Item name="url" label="网页链接" rules={[{ required: true, message: '请输入链接' }]}>
                    <Input placeholder="https://example.com/product/xxx" size="large" prefix={<LinkOutlined />} />
                  </Form.Item>
                  <Form.Item name="docType" label="资料类型">
                    <Radio.Group optionType="button" buttonStyle="solid" options={DOC_TYPE_OPTIONS as unknown as { label: string; value: string }[]} />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={submitting}>
                      抓取并提取
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
            {
              key: 'transcript',
              label: (
                <Space>
                  <MessageOutlined /> 对话纪要
                </Space>
              ),
              children: (
                <Form form={transcriptForm} layout="vertical" onFinish={submitTranscript} initialValues={{ docType: 'meeting' }}>
                  <Form.Item name="title" label="纪要标题（可选）">
                    <Input placeholder="例如：9 月 27 日智能灯光方案沟通纪要" maxLength={100} />
                  </Form.Item>
                  <Form.Item name="text" label="纪要原文" rules={[{ required: true, message: '请粘贴纪要内容' }, { min: 20, message: '至少 20 个字符' }]}>
                    <Input.TextArea rows={8} placeholder="粘贴客户沟通 / 会议纪要原文，AI 将抽取主题、时间、结论、待办等结构化字段" showCount maxLength={200_000} />
                  </Form.Item>
                  <Space align="start" wrap>
                    <Form.Item name="docType" noStyle>
                      <Radio.Group optionType="button" buttonStyle="solid" options={DOC_TYPE_OPTIONS as unknown as { label: string; value: string }[]} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={submitting}>
                      结构化提取
                    </Button>
                  </Space>
                </Form>
              ),
            },
          ]}
        />
      </Card>

      <Card>
        <Tabs
          defaultActiveKey="jobs"
          items={[
            {
              key: 'jobs',
              label: `提取任务（${jobs.length}）`,
              children: (
                <Table<JobRow>
                  rowKey="id"
                  loading={loading}
                  dataSource={jobs}
                  columns={jobColumns}
                  pagination={{ pageSize: 8, hideOnSinglePage: true }}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无提取任务，从上方任一来源开始" /> }}
                />
              ),
            },
            {
              key: 'docs',
              label: `已入库文档（${docs.length}）`,
              children: (
                <Table<DocRow>
                  rowKey="id"
                  loading={loading}
                  dataSource={docs}
                  pagination={{ pageSize: 8, hideOnSinglePage: true }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="确认后的文档将在此沉淀，供 S4 知识库 RAG 复用" /> }}
                  columns={[
                    { title: '文档标题', dataIndex: 'title', ellipsis: true },
                    {
                      title: '类型',
                      dataIndex: 'docType',
                      width: 100,
                      render: (v: string) => DOC_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v,
                    },
                    { title: '质量分', width: 90, render: (_: unknown, r: DocRow) => r.job.score ?? '-' },
                    { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      <ReviewDrawer
        job={reviewJob}
        loading={reviewLoading}
        onClose={() => setReviewJob(null)}
        onChanged={async () => {
          await refresh();
          if (reviewJob) await openReview(reviewJob.id);
        }}
      />
    </div>
  );
}

function ReviewDrawer({
  job,
  loading,
  onClose,
  onChanged,
}: {
  job: JobDetail | null;
  loading: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = useToken();
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (job?.document) {
      const init: Record<string, string> = {};
      for (const f of job.document.fields) init[f.key] = f.value;
      // 缺失字段也要出现在表单中供补全
      for (const d of job.deficiencies) {
        if (!(d.fieldKey in init)) init[d.fieldKey] = '';
      }
      setValues(init);
    }
  }, [job]);

  if (!job) return <Drawer open={false} onClose={onClose} width={720} />;

  const missingKeys = new Set(job.deficiencies.filter((d) => !d.resolved).map((d) => d.fieldKey));

  const submit = async (action: 'confirm' | 'reject'): Promise<void> => {
    setSubmitting(true);
    try {
      await api(`/api/content/extractions/${job.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ fields: values, action }),
      });
      message.success(action === 'confirm' ? '已确认入库' : '已驳回');
      await onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={!!job}
      onClose={onClose}
      width={720}
      title={
        <Space wrap>
          <FileSearchOutlined />
          <span>提取结果评审</span>
          <Tag color={STATUS_META[job.status].color}>{STATUS_META[job.status].label}</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button onClick={() => void submit('reject')} loading={submitting}>
            驳回
          </Button>
          <Button type="primary" onClick={() => void submit('confirm')} loading={submitting}>
            确认入库
          </Button>
        </Space>
      }
    >
      {loading ? (
        <Text type="secondary">加载中…</Text>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="来源">{SOURCE_LABEL[job.source]}</Descriptions.Item>
            <Descriptions.Item label="质量评分">
              {job.score === null ? '-' : <Text strong>{job.score} / 100</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="来源标识" span={2}>
              <Text type="secondary">{job.sourceRef}</Text>
            </Descriptions.Item>
          </Descriptions>

          {job.error ? <Alert type="error" showIcon message="提取失败" description={job.error} /> : null}

          {job.status === 'FAILED' ? null : (
            <>
              {job.score !== null ? (
                <Progress
                  percent={job.score}
                  status={job.score >= 80 ? 'success' : job.score >= 50 ? 'normal' : 'exception'}
                  strokeColor={job.score >= 80 ? token.colorSuccess : job.score >= 50 ? token.colorPrimary : token.colorError}
                />
              ) : null}

              {missingKeys.size > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`检测到 ${missingKeys.size} 个必需字段缺失，请补全后确认入库`}
                  description={job.deficiencies
                    .filter((d) => !d.resolved)
                    .map((d) => d.reason)
                    .join('；')}
                />
              ) : (
                <Alert type="success" showIcon message="必需字段完整，可直接确认入库" />
              )}

              <Card size="small" title="结构化字段（可人工修正，确认后按此内容入库）">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {job.document?.fields.map((field) => (
                    <div key={field.id}>
                      <Space size={6} style={{ marginBottom: 4 }}>
                        <Text strong>{field.label}</Text>
                        {field.required ? <Tag color="red">必需</Tag> : <Tag>选填</Tag>}
                        {missingKeys.has(field.key) ? <Tag color="warning">缺失</Tag> : null}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          置信度 {field.confidence}
                        </Text>
                      </Space>
                      <Input.TextArea
                        rows={field.key === 'sellingPoints' || field.key === 'specs' || field.key === 'decisions' || field.key === 'todos' ? 3 : 1}
                        value={values[field.key] ?? ''}
                        status={missingKeys.has(field.key) ? 'warning' : undefined}
                        onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                  {job.deficiencies
                    .filter((d) => !job.document?.fields.some((f) => f.key === d.fieldKey))
                    .map((d) => (
                      <div key={d.id}>
                        <Space size={6} style={{ marginBottom: 4 }}>
                          <Text strong>{d.label}</Text>
                          <Tag color="red">必需</Tag>
                          <Tag color="warning">缺失</Tag>
                        </Space>
                        <Input.TextArea
                          rows={2}
                          value={values[d.fieldKey] ?? ''}
                          status="warning"
                          placeholder="人工补全该字段"
                          onChange={(e) => setValues((prev) => ({ ...prev, [d.fieldKey]: e.target.value }))}
                        />
                      </div>
                    ))}
                </Space>
              </Card>

              <Card size="small" title="原文预览">
                <Paragraph
                  type="secondary"
                  style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', marginBottom: 0, fontSize: 13 }}
                  ellipsis={{ rows: 12, expandable: true, symbol: '展开全文' }}
                >
                  {job.document?.content ?? ''}
                </Paragraph>
              </Card>
            </>
          )}
        </Space>
      )}
    </Drawer>
  );
}
