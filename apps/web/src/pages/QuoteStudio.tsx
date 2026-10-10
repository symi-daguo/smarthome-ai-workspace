import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Card, Empty, Input, InputNumber, Segmented, Space, Table, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { catMeta } from '../lib/pointOverlay';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text } = Typography;

interface Product {
  id: string;
  name: string;
  category: string;
  unit: string;
  spec: string;
  sku: string;
  barcode: string;
  snRule: string;
  warranty: number;
  priceMin: number;
  priceMax: number;
  perRoom: string;
  priceRetail: number;
  priceDealer: number;
  priceProject: number;
  rebateL1: number;
  rebateL2: number;
  rebateDesigner: number;
}

interface Line {
  product: Product;
  qty: number;
}

/** 计价口径：对外报价按官方指导价或工程价；成本一律取经销价（兼容旧数据回退参考价下限） */
type PriceMode = 'retail' | 'project';

function money(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : n.toLocaleString('zh-CN');
}

/** 对外成交单价（口径切换）；旧产品缺三级价时回退区间值 */
function sellPrice(p: Product, mode: PriceMode): number {
  return mode === 'retail' ? p.priceRetail || p.priceMax || 0 : p.priceProject || p.priceMin || 0;
}

/** 门店进货成本（经销价）；旧数据回退参考价下限 */
function costPrice(p: Product): number {
  return p.priceDealer || p.priceMin || 0;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 智能报价：标准配单 + 计价口径切换 + 成本毛利与多级返利测算，导出标准 CSV 报价单 */
export function QuoteStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [project, setProject] = useState('');
  const [customer, setCustomer] = useState('');
  const [mode, setMode] = useState<PriceMode>('retail');

  useEffect(() => {
    api<Product[]>('/api/products').then(setProducts).catch((e) => message.error((e as Error).message));
  }, [message]);

  const addProduct = (product: Product): void => {
    setLines((prev) => {
      const hit = prev.find((l) => l.product.id === product.id);
      if (hit) return prev.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { product, qty: 1 }];
    });
  };

  const setQty = (id: string, qty: number): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, qty: Math.max(0, qty) } : l)).filter((l) => l.qty > 0));
  };

  const totals = useMemo(() => {
    const sell = lines.reduce((s, l) => s + sellPrice(l.product, mode) * l.qty, 0);
    const cost = lines.reduce((s, l) => s + costPrice(l.product) * l.qty, 0);
    const count = lines.reduce((s, l) => s + l.qty, 0);
    // 返利口径：一/二级返点按进货额计提，设计师返点按对外成交额计提
    const l1 = lines.reduce((s, l) => s + (costPrice(l.product) * l.qty * l.product.rebateL1) / 100, 0);
    const l2 = lines.reduce((s, l) => s + (costPrice(l.product) * l.qty * l.product.rebateL2) / 100, 0);
    const designer = lines.reduce((s, l) => s + (sellPrice(l.product, mode) * l.qty * l.product.rebateDesigner) / 100, 0);
    return { sell, cost, count, profit: sell - cost, l1, l2, designer };
  }, [lines, mode]);

  const exportCsv = (): void => {
    if (!lines.length) {
      message.warning('请先添加产品');
      return;
    }
    const modeLabel = mode === 'retail' ? '官方指导价' : '工程价';
    const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [
      [esc('全屋智能方案报价单'), esc(project || '未命名项目'), esc('客户'), esc(customer || ''), esc('计价口径'), esc(modeLabel), esc(''), esc(''), esc(''), esc('')],
      [esc('序号'), esc('SKU'), esc('条码'), esc('SN 规则'), esc('品类'), esc('产品名称'), esc('规格'), esc('单位'), esc('数量'), esc(`单价(${modeLabel})`)],
      ...lines.flatMap((l, i) => [
        [
          esc(i + 1), esc(l.product.sku), esc(l.product.barcode), esc(l.product.snRule ? `${l.product.snRule}****` : ''),
          esc(catMeta(l.product.category).label), esc(l.product.name), esc(l.product.spec), esc(l.product.unit || '台'), l.qty,
          esc(sellPrice(l.product, mode).toLocaleString('zh-CN')),
        ],
        [esc(''), esc('经销成本单价'), esc(costPrice(l.product).toLocaleString('zh-CN')), esc('指导/工程/经销'), esc(`${l.product.priceRetail}/${l.product.priceProject}/${l.product.priceDealer}`),
          esc('返点%（一/二/设计师）'), esc(`${l.product.rebateL1}/${l.product.rebateL2}/${l.product.rebateDesigner}`), esc('质保'), esc(l.product.warranty >= 12 && l.product.warranty % 12 === 0 ? `${l.product.warranty / 12}年` : `${l.product.warranty}月`), esc('')],
      ]),
      [esc(''), esc('对外报价合计'), esc(totals.sell.toLocaleString('zh-CN')), esc('经销成本合计'), esc(totals.cost.toLocaleString('zh-CN')), esc('毛利合计'), esc((totals.sell - totals.cost).toLocaleString('zh-CN')), esc(''), esc(''), esc('')],
      [esc(''), esc('一级返利(按进货额)'), esc(totals.l1.toFixed(1)), esc('二级返利(按进货额)'), esc(totals.l2.toFixed(1)), esc('设计师返利(按成交额)'), esc(totals.designer.toFixed(1)), esc(''), esc(''), esc('')],
      [esc('说明'), esc('以上价格与返利比例由部署者在产品中心维护，不含安装辅材与人工；实际成交价以合同为准。'), esc(''), esc(''), esc(''), esc(''), esc(''), esc(''), esc(''), esc('')],
    ];
    downloadBlob(new Blob([`\ufeff${rows.map((r) => r.join(','))}\n`], { type: 'text/csv;charset=utf-8' }), `${project || '全屋智能'}-报价单.csv`);
    message.success('报价单已导出');
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()];
  }, [products]);

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="智能报价"
        description="从产品库选品配单，按官方指导价或工程价切换计价口径，自动测算经销成本、毛利与多级返利，导出标准报价单"
        extra={
          <Space wrap>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as PriceMode)}
              options={[{ label: '按官方指导价', value: 'retail' }, { label: '按工程价', value: 'project' }]}
            />
            <Button type="primary" icon={<DownloadOutlined />} disabled={!lines.length} onClick={exportCsv}
              style={{ background: BRAND_GRADIENT, border: 'none' }}>
              导出报价单 CSV
            </Button>
          </Space>
        }
      />

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 左：产品库（flex 百分比，宽屏随内容区拉宽） */}
        <Card
          title="产品库（点击加入报价单）"
          size="small"
          style={{ flex: '1 1 300px', minWidth: 280, maxWidth: 380 }}
          styles={{ body: { padding: '10px 14px', maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
        >
          {grouped.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <Tag color={catMeta(cat).color} style={{ marginBottom: 6 }}>{catMeta(cat).label}</Tag>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {list.map((p) => (
                  <Button key={p.id} block size="small" style={{ textAlign: 'left', height: 'auto', padding: '5px 10px', whiteSpace: 'normal' }} onClick={() => addProduct(p)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                      <span style={{ fontSize: 11, opacity: 0.7, flexShrink: 0 }}>¥{sellPrice(p, mode)}/{p.unit || '台'}</span>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.6 }}>
                      {p.sku ? `SKU ${p.sku} · ` : ''}{p.perRoom || '按需布置'}
                    </div>
                  </Button>
                ))}
              </Space>
            </div>
          ))}
        </Card>

        {/* 右：报价单 */}
        <Card
          style={{ flex: '3 1 560px', minWidth: 320 }}
          title={
            <Space wrap>
              <Input value={project} onChange={(e) => setProject(e.target.value)} maxLength={40} placeholder="项目名（如：140㎡三室两厅全屋智能）" style={{ width: 240 }} size="small" />
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={20} placeholder="客户称呼" style={{ width: 140 }} size="small" />
            </Space>
          }
        >
          {lines.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="报价单为空，从左侧产品库点击添加设备" style={{ padding: '40px 0' }} />
          ) : (
            <>
              <Table<Line>
                rowKey={(l) => l.product.id}
                dataSource={lines}
                pagination={false}
                size="small"
                scroll={{ x: 860 }}
                columns={[
                  { title: 'SKU', width: 92, render: (_, l) => <Text type="secondary" style={{ fontSize: 12 }}>{l.product.sku || '—'}</Text> },
                  { title: '品类', width: 84, render: (_, l) => <Tag color={catMeta(l.product.category).color} style={{ marginInlineEnd: 0 }}>{catMeta(l.product.category).label}</Tag> },
                  {
                    title: '产品 / 规格',
                    render: (_, l) => (
                      <div>
                        <Text strong style={{ fontSize: 13 }}>{l.product.name}</Text>
                        {l.product.spec ? <div><Text type="secondary" style={{ fontSize: 11 }}>{l.product.spec}</Text></div> : null}
                      </div>
                    ),
                  },
                  { title: '数量', width: 110, render: (_, l) => (
                    <Space size={4}>
                      <InputNumber min={1} max={999} value={l.qty} onChange={(v) => setQty(l.product.id, Number(v ?? 0))} size="small" style={{ width: 64 }} />
                      <Text type="secondary" style={{ fontSize: 12 }}>{l.product.unit || '台'}</Text>
                    </Space>
                  ) },
                  { title: mode === 'retail' ? '指导价单价' : '工程价单价', width: 100, align: 'right', render: (_, l) => `¥${sellPrice(l.product, mode)}` },
                  { title: '经销成本', width: 92, align: 'right', render: (_, l) => <Text type="success">¥{costPrice(l.product)}</Text> },
                  {
                    title: '小计 / 毛利',
                    width: 150,
                    align: 'right',
                    render: (_, l) => (
                      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                        <div><Text strong>¥{money(sellPrice(l.product, mode) * l.qty)}</Text></div>
                        <div><Text type="secondary">毛利 ¥{money((sellPrice(l.product, mode) - costPrice(l.product)) * l.qty)}</Text></div>
                      </div>
                    ),
                  },
                ]}
              />

              {/* 汇总卡：对外报价、成本、毛利、三级返利测算 */}
              <div
                style={{
                  marginTop: 14,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 10,
                }}
              >
                {[
                  { label: `对外报价合计（${mode === 'retail' ? '指导价' : '工程价'}）`, value: `¥${money(totals.sell)}`, strong: true },
                  { label: `设备 ${totals.count} 件 · 经销成本`, value: `¥${money(totals.cost)}` },
                  { label: '预估毛利', value: `¥${money(totals.profit)}` },
                  { label: '一级返利（进货额计提）', value: `¥${totals.l1.toFixed(0)}` },
                  { label: '二级返利（进货额计提）', value: `¥${totals.l2.toFixed(0)}` },
                  { label: '设计师返利（成交额计提）', value: `¥${totals.designer.toFixed(0)}` },
                ].map((c) => (
                  <div key={c.label} style={{ border: `1px solid rgba(0,0,0,.08)`, borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: 'rgba(0,0,0,.45)', marginBottom: 4 }}>{c.label}</div>
                    <Text strong style={{ fontSize: c.strong ? 18 : 15 }}>{c.value}</Text>
                  </div>
                ))}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
                返利口径：一级/二级返点按经销进货额计提，设计师返点按对外成交额计提；比例在「产品中心 → 编辑产品」维护，单价由部署者配置，平台不预设商业定价。
              </Text>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
