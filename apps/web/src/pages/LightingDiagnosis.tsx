import { useCallback, useEffect, useMemo, useState, type ReactNode, useRef } from 'react';
import { newRequestId } from '../lib/request-id';
import { App as AntApp, Button, Card, Empty, Grid, Radio, Space, Spin, Table, Tag, Typography, theme } from 'antd';
import { ThunderboltFilled } from '@ant-design/icons';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { fillHeightContainerStyle } from '../theme/tokens';

const { Text, Title, Paragraph } = Typography;

interface Question { id: string; text: string; options: string[] }
interface Mode { id: string; icon: string; title: string; description: string; questions: Question[] }
interface ModesResp { modes: Mode[]; boundary: string }
interface Diagnosis {
  summary: string;
  issues: { level: 'A' | 'B' | 'pending'; text: string }[];
  circuits: { group: string; usage: string; control: string }[];
  scenes: { name: string; lights: string; feeling: string }[];
  placement: string[];
  boundary: string;
}

/** 分级配色：A 级是"必须先处理"的硬伤，用红；B 级是优化项用橙；待确认用灰（不是问题，是没核实） */
const LEVEL_META: Record<Diagnosis['issues'][number]['level'], { color: string; label: string; hint: string }> = {
  A: { color: 'error', label: 'A级', hint: '需优先处理' },
  B: { color: 'warning', label: 'B级', hint: '建议优化' },
  pending: { color: 'default', label: '待确认', hint: '需核对图纸或现场条件' },
};

/**
 * 智能灯光问诊（G-16）
 *
 * 任务与选项来自 `GET /api/lighting/diagnose/modes`——定义只在后端存一份，
 * 前端只负责渲染，不自己另存一份选项（另存就迟早对不上）。
 *
 * 设计依据：replica/audit-2026-10-13.md §7.26（记录了对照实现与任务/选项的来源）
 */
export function LightingDiagnosis(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const [modes, setModes] = useState<Mode[]>([]);
  const [boundary, setBoundary] = useState('');
  const [step, setStep] = useState(0);
  const [modeId, setModeId] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Diagnosis | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<ModesResp>('/api/lighting/diagnose/modes')
      .then((d) => {
        if (!alive) return;
        setModes(d.modes);
        setBoundary(d.boundary);
      })
      .catch(() => {
        if (alive) message.error('灯光问诊加载失败，请检查网络后重试');
      });
    return () => { alive = false; };
  }, [message]);

  const mode = useMemo(() => modes.find((m) => m.id === modeId), [modes, modeId]);
  const answered = mode ? mode.questions.filter((q) => answers[q.id]).length : 0;
  const allAnswered = mode ? answered === mode.questions.length : false;

  const reset = useCallback(() => {
    setStep(0);
    setModeId('');
    setAnswers({});
    setResult(null);
  }, []);

  /** 幂等键：同一次点击重试（弱网/手抖）不该让用户付两次钱 */
  const reqIdRef = useRef<string | null>(null);

  const run = async (): Promise<void> => {
    if (!modeId) return;
    setRunning(true);
    const rid = reqIdRef.current ?? newRequestId();
    reqIdRef.current = rid;
    try {
      setResult(await api<Diagnosis>('/api/lighting/diagnose', {
        method: 'POST',
        body: JSON.stringify({ modeId, answers, clientRequestId: rid }),
      }));
      reqIdRef.current = null;
      setStep(2);
    } catch (e) {
      message.error((e as Error).message || '问诊失败，请重试');
    } finally {
      setRunning(false);
    }
  };

  const issueRows = useMemo(
    () => (result?.issues ?? []).map((i, idx) => ({
      key: `${i.level}-${idx}`,
      level: i.level,
      text: i.text,
    })),
    [result],
  );

  return (
    <div style={{ ...fillHeightContainerStyle, width: '100%' }}>
      <PageHeader title="智能灯光问诊" description="五项任务逐题问诊，给出分级问题、灯组与场景建议" />

      <div style={{ maxWidth: 940, margin: '0 auto', padding: '0 16px 32px' }}>
        {step === 0 ? (
          <>
            <Paragraph type="secondary">先选择本次要解决的问题</Paragraph>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${screens.md ? 300 : 240}px, 1fr))`, gap: 14 }}>
              {modes.map((m) => (
                <Card
                  key={m.id}
                  hoverable
                  onClick={() => { setModeId(m.id); setAnswers({}); setStep(1); }}
                  styles={{ body: { padding: 18 } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 20, color: token.colorPrimary }}>{m.icon}</span>
                    <Text strong style={{ fontSize: 15 }}>{m.title}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12.5 }}>{m.description}</Text>
                </Card>
              ))}
            </div>
            {modes.length === 0 ? <Empty description="正在加载任务…" style={{ marginTop: 60 }} /> : null}
          </>
        ) : null}

        {step === 1 && mode ? (
          <Card
            title={mode.title}
            extra={<Button size="small" type="text" onClick={reset}>换任务</Button>}
            styles={{ body: { padding: 20 } }}
          >
            <Space direction="vertical" size={18} style={{ width: '100%' }}>
              {mode.questions.map((q) => (
                <div key={q.id}>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>{q.text}</Text>
                  <Radio.Group
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  >
                    <Space wrap size={[8, 10]}>
                      {q.options.map((o) => (
                        <Radio.Button key={o} value={o}>{o}</Radio.Button>
                      ))}
                    </Space>
                  </Radio.Group>
                </div>
              ))}
            </Space>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 22 }}>
              <Button type="primary" disabled={!allAnswered} loading={running} icon={<ThunderboltFilled />} onClick={() => void run()}>
                生成灯光建议
              </Button>

              <Text type="secondary" style={{ fontSize: 12 }}>
                已回答 {answered}/{mode.questions.length} 题{allAnswered ? '' : '（全部作答后可生成）'}
              </Text>
            </div>
          </Card>
        ) : null}

        {step === 2 && result ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card title="总体判断" extra={<Button size="small" onClick={reset}>重新问诊</Button>}>
              <Text>{result.summary}</Text>
            </Card>

            <Card
              title="问题分级"
              extra={
                <Space size={6}>
                  {(['A', 'B', 'pending'] as const).map((lv) => {
                    const n = result.issues.filter((i) => i.level === lv).length;
                    return n > 0 ? <Tag key={lv} color={LEVEL_META[lv].color}>{LEVEL_META[lv].label} {n}</Tag> : null;
                  })}
                </Space>
              }
            >
              {issueRows.length === 0 ? (
                <Text type="secondary">本次没有识别出明显问题</Text>
              ) : (
                <Table<{ level: Diagnosis['issues'][number]['level']; text: string }>
                  size="small"
                  pagination={false}
                  dataSource={issueRows}
                  columns={[
                    {
                      title: '等级',
                      dataIndex: 'level',
                      width: 150,
                      render: (lv: Diagnosis['issues'][number]['level']) => (
                        <Space size={4} direction="vertical" style={{ lineHeight: 1.3 }}>
                          <Tag color={LEVEL_META[lv].color}>{LEVEL_META[lv].label}</Tag>
                          <Text type="secondary" style={{ fontSize: 11 }}>{LEVEL_META[lv].hint}</Text>
                        </Space>
                      ),
                    },
                    { title: '问题', dataIndex: 'text' },
                  ]}
                />
              )}
            </Card>

            <Card title="全屋灯组建议">
              <Table
                size="small"
                pagination={false}
                dataSource={result.circuits.map((c, i) => ({ key: i, ...c }))}
                columns={[
                  { title: '灯组', dataIndex: 'group', width: 140 },
                  { title: '用途', dataIndex: 'usage' },
                  { title: '控制建议', dataIndex: 'control' },
                ]}
              />
            </Card>

            <Card title="智能场景建议">
              <Table
                size="small"
                pagination={false}
                dataSource={result.scenes.map((x, i) => ({ key: i, ...x }))}
                columns={[
                  { title: '场景', dataIndex: 'name', width: 140 },
                  { title: '主要灯光', dataIndex: 'lights' },
                  { title: '感觉', dataIndex: 'feeling' },
                ]}
              />
            </Card>

            {result.placement.length > 0 ? (
              <Card title="大致灯位建议">
                <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
                  {result.placement.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </Card>
            ) : null}

            {/* 边界声明不是客套话：门店会把这些建议当施工依据，不写清楚会出人祸 */}
            <Card styles={{ body: { padding: 14 } }}>
              <Text type="secondary" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                ⓘ {result.boundary || boundary}
              </Text>
            </Card>
          </Space>
        ) : null}

        {running ? (
          <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.6)', zIndex: 1000 }}>
            <Spin tip="正在分析，请稍候…" size="large"><div style={{ width: 220, height: 90 }} /></Spin>
          </div>
        ) : null}
      </div>
    </div>
  );
}
