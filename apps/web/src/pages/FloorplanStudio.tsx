import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Card, Col, Empty, Input, Row, Space, Spin, Tag, Typography } from 'antd';
import { api, fileUrl } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

const { Text, Title } = Typography;

/** 方案摘要（与 /api/plans 的返回形状对齐） */
interface PlanSummary {
  id: string;
  title: string;
  customer?: string | null;
  pageCount: number;
  versionNo: number;
  updatedAt: string;
}

/** 平面图现状：有没有底图、有多少点位 */
interface PlanFloorplan {
  floorplanAssetId?: string | null;
  layoutPoints?: unknown[] | null;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 平面图与点位设计（专门板块）。
 *
 * 为什么单独做一个板块，而不是把点位编辑器塞进百宝箱或方案页里：
 * 1. **点位要反复改**。上传户型图 → 布点 → 改型号 → 挪位置 → 改回去，是一条会走很多遍的线，
 *    藏在方案流程的某一步里，改一次就得重走整个流程。
 * 2. **点位是方案与 PPT 的共同数据源**。方案的空间动线页读它，PPT 的点位清单页也读它。
 *    改完点位，PPT 里必须跟着变 —— 所以它需要一个独立、可反复进入的工作台。
 * 3. **谁有方案谁改点位**。板块按方案列，一张平面图对应一个方案，点位与方案一一对应，
 *    不会出现「这张图纸是哪套方案点位」的对应关系丢失。
 */
export function FloorplanStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [details, setDetails] = useState<Record<string, PlanFloorplan>>({});
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await api<PlanSummary[]>('/api/plans');
        if (cancelled) return;
        setPlans(list);
        // 逐个取详情只为拿平面图现状（底图与点位数量）。
        // 列表接口不返回这两个字段，而它们决定卡片上显示「已有点位 N 个」还是「尚未布点」。
        const entries = await Promise.all(
          list.map(async (p) => {
            try {
              const d = await api<PlanFloorplan>(`/api/plans/${p.id}`);
              return [p.id, d] as const;
            } catch {
              return [p.id, {} as PlanFloorplan] as const;
            }
          }),
        );
        if (cancelled) return;
        setDetails(Object.fromEntries(entries));
      } catch (e) {
        if (!cancelled) message.error((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [message]);

  const filtered = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return plans;
    return plans.filter((p) => `${p.title} ${p.customer ?? ''}`.toLowerCase().includes(kw.toLowerCase()));
  }, [plans, keyword]);

  return (
    <div>
      <PageHeader
        title="平面图与点位"
        description="上传客户户型图、布点、拖拽微调；点位与方案一一对应，改完保存，方案与 PPT 会一起用上新的点位。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card
            title="按方案继续改点位"
            extra={
              <Space>
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜方案名 / 客户"
                  allowClear
                  style={{ width: 180 }}
                />
              </Space>
            }
          >
            {loading ? (
              <Spin style={{ display: 'block', padding: '48px 0' }} />
            ) : filtered.length === 0 ? (
              <Empty description={plans.length ? '没有匹配的方案' : '还没有方案。先到「智能方案」建一个，再回这里布点。'} style={{ padding: '48px 0' }}>
                <Space>
                  <Button type="primary" onClick={() => navigate('/plan')}>去建方案</Button>
                  <Button onClick={() => navigate('/device-layout')}>只做图纸（不挂方案）</Button>
                </Space>
              </Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filtered.map((p) => {
                  const d = details[p.id] ?? {};
                  const n = d.layoutPoints?.length ?? 0;
                  const hasImage = Boolean(d.floorplanAssetId);
                  return (
                    <Card
                      key={p.id}
                      size="small"
                      styles={{ body: { padding: 12 } }}
                      style={{ borderRadius: 10 }}
                    >
                      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div
                          style={{
                            width: 96,
                            height: 68,
                            borderRadius: 8,
                            overflow: 'hidden',
                            background: '#f5f5f5',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flex: 'none',
                            border: '1px solid #f0f0f0',
                          }}
                        >
                          {hasImage ? (
                            <img
                              src={fileUrl(`/api/media/assets/${d.floorplanAssetId}/file`)}
                              alt="户型图"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            <Text type="secondary" style={{ fontSize: 11 }}>无底图</Text>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <Text strong>{p.title}</Text>
                            {n > 0 ? <Tag color="blue">已布 {n} 个点位</Tag> : <Tag>尚未布点</Tag>}
                            {!hasImage && <Tag color="orange">缺户型图</Tag>}
                          </div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {p.customer ? `${p.customer} · ` : ''}{p.pageCount} 页文案 · 版本 {p.versionNo} · {formatTime(p.updatedAt)}
                          </Text>
                        </div>
                        <Space>
                          <Button size="small" onClick={() => navigate(`/plan?id=${p.id}`)}>看方案</Button>
                          <Button size="small" type="primary" onClick={() => navigate(`/device-layout?planId=${p.id}`)}>
                            {n > 0 ? '继续改点位' : '去布点'}
                          </Button>
                        </Space>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="新建平面图">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                上传客户户型图后开始布点。点位会先存为独立图纸，需要挂到方案时再从上方选方案进入。
              </Text>
              <Button type="primary" block onClick={() => navigate('/device-layout')}>
                上传户型图并布点
              </Button>
              <Button block onClick={() => navigate('/device-layout?mode=light')}>
                灯光点位效果图
              </Button>
              <Button block onClick={() => navigate('/device-layout?mode=wifi')}>
                WiFi 信号热力图
              </Button>
            </Space>
          </Card>

          <Card title="点位会怎么被用到" style={{ marginTop: 16 }}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text style={{ fontSize: 13 }}>· 方案的空间动线页会画上这些点位</Text>
              <Text style={{ fontSize: 13 }}>· 方案里的设备清单与报价按点位实时统计</Text>
              <Text style={{ fontSize: 13 }}>· 导出的 PPT 与 PDF 会带上点位与清单</Text>
            </Space>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              改完点位后回到方案页重新导出一次，PPT 拿到的就是最新点位 —— 不需要重建方案。
            </Text>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
