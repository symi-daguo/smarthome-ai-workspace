import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Card, Empty, Grid, Input, InputNumber, Modal, Segmented, Space, Table, Tag, Typography, theme } from 'antd';
import { DownloadOutlined, EditOutlined, FileExcelOutlined, SwapOutlined } from '@ant-design/icons';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { catMeta } from '../lib/pointOverlay';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';
import { variantFamily, variantGroups, variantMeta, variantSiblings } from '../data/quoteVariants';

const { Text, Link } = Typography;

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
  /** 本次单价覆盖：只存在于页面草稿状态，不写入产品库；undefined 表示按口径取标准价 */
  unitPrice?: number;
  /** 房间（导出报价单用） */
  room: string;
  /** 行备注（导出报价单用） */
  note: string;
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

/** 行内对外单价：优先本次谈定的逐项覆盖价，否则按口径取产品标准价 */
function lineSellPrice(l: Line, mode: PriceMode): number {
  return l.unitPrice ?? sellPrice(l.product, mode);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 导出单元格里的数字：不带货币符号与千分位，方便在 Excel/WPS 里直接求和 */
function plainNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** 智能报价：标准配单 + 换规格 + 逐项单价覆盖 + 计价口径切换 + 成本毛利与多级返利测算，导出 CSV / Excel 报价单 */
export function QuoteStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  // 窄屏只在首屏渲染前为 undefined，取 false 表示先按宽屏排版，避免列先出现再消失
  const isNarrow = screens.md === false;
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [project, setProject] = useState('');
  const [customer, setCustomer] = useState('');
  const [mode, setMode] = useState<PriceMode>('retail');
  /** 正在换规格的行（以该行产品 id 表示）；null 表示弹窗关闭 */
  const [variantLineId, setVariantLineId] = useState<string | null>(null);
  /** 正在改单价的行（以该行产品 id 表示） */
  const [priceLineId, setPriceLineId] = useState<string | null>(null);
  /** 改单价弹窗里的输入值；null 表示不覆盖（走标准价） */
  const [priceDraft, setPriceDraft] = useState<number | null>(null);

  useEffect(() => {
    api<Product[]>('/api/products').then(setProducts).catch((e) => message.error((e as Error).message));
  }, [message]);

  const addProduct = (product: Product): void => {
    setLines((prev) => {
      const hit = prev.find((l) => l.product.id === product.id);
      if (hit) return prev.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { product, qty: 1, room: '', note: '' }];
    });
  };

  const setQty = (id: string, qty: number): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, qty: Math.max(0, qty) } : l)).filter((l) => l.qty > 0));
  };

  const setLineText = (id: string, patch: Partial<Pick<Line, 'room' | 'note'>>): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, ...patch } : l)));
  };

  const resetUnitPrice = (id: string): void => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, unitPrice: undefined } : l)));
  };

  const openPrice = (l: Line): void => {
    setPriceLineId(l.product.id);
    setPriceDraft(l.unitPrice ?? null);
  };

  const savePrice = (): void => {
    if (!priceLineId) return;
    const id = priceLineId;
    // 一个 updater 里一次写完：填了数就是覆盖价，清空输入则回到标准价
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, unitPrice: priceDraft != null ? Math.max(0, priceDraft) : undefined } : l)));
    setPriceLineId(null);
    message.success(priceDraft != null ? '已应用本次单价，仅本次报价生效' : '已恢复标准价');
  };

  /**
   * 换规格：替换当前行的产品，不新增行。
   * 目标规格已被别行占用时合并数量；覆盖价是针对具体规格谈的，换规格后必须清掉，避免旧价串到新规格上。
   */
  const switchVariant = (next: Product): void => {
    if (!variantLineId) return;
    const id = variantLineId;
    // updater 要到渲染阶段才执行，这里从当前 lines 快照读，避免提示判断读到未赋值的 false
    const hadOverride = lines.some((l) => l.product.id === id && l.unitPrice != null);
    setLines((prev) => {
      const cur = prev.find((l) => l.product.id === id);
      if (!cur) return prev;
      const rest = prev.filter((l) => l.product.id !== id);
      const hit = rest.find((l) => l.product.id === next.id);
      if (hit) {
        return rest.map((l) => (l.product.id === next.id ? { ...l, qty: l.qty + cur.qty, room: l.room || cur.room, note: l.note || cur.note } : l));
      }
      return prev.map((l) => (l.product.id === id ? { ...l, product: next, unitPrice: undefined } : l));
    });
    setVariantLineId(null);
    if (hadOverride) message.info('规格已切换，本次单价已清空，请重新填写');
  };

  const totals = useMemo(() => {
    const sell = lines.reduce((s, l) => s + lineSellPrice(l, mode) * l.qty, 0);
    const cost = lines.reduce((s, l) => s + costPrice(l.product) * l.qty, 0);
    const count = lines.reduce((s, l) => s + l.qty, 0);
    // 返利口径：一/二级返点按进货额计提（不受覆盖价影响），设计师返点按对外成交额计提（含覆盖价）
    const l1 = lines.reduce((s, l) => s + (costPrice(l.product) * l.qty * l.product.rebateL1) / 100, 0);
    const l2 = lines.reduce((s, l) => s + (costPrice(l.product) * l.qty * l.product.rebateL2) / 100, 0);
    const designer = lines.reduce((s, l) => s + (lineSellPrice(l, mode) * l.qty * l.product.rebateDesigner) / 100, 0);
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
          esc(`${plainNum(lineSellPrice(l, mode))}${l.unitPrice != null ? '*' : ''}`),
        ],
        [esc(''), esc('经销成本单价'), esc(costPrice(l.product).toLocaleString('zh-CN')), esc('指导/工程/经销'), esc(`${l.product.priceRetail}/${l.product.priceProject}/${l.product.priceDealer}`),
          esc('返点%（一/二/设计师）'), esc(`${l.product.rebateL1}/${l.product.rebateL2}/${l.product.rebateDesigner}`), esc('质保'), esc(l.product.warranty >= 12 && l.product.warranty % 12 === 0 ? `${l.product.warranty / 12}年` : `${l.product.warranty}月`), esc('')],
      ]),
      [esc(''), esc('对外报价合计'), esc(totals.sell.toLocaleString('zh-CN')), esc('经销成本合计'), esc(totals.cost.toLocaleString('zh-CN')), esc('毛利合计'), esc((totals.sell - totals.cost).toLocaleString('zh-CN')), esc(''), esc(''), esc('')],
      [esc(''), esc('一级返利(按进货额)'), esc(totals.l1.toFixed(1)), esc('二级返利(按进货额)'), esc(totals.l2.toFixed(1)), esc('设计师返利(按成交额)'), esc(totals.designer.toFixed(1)), esc(''), esc(''), esc('')],
      [esc('说明'), esc('以上价格与返利比例由部署者在产品中心维护，不含安装辅材与人工；实际成交价以合同为准。标 * 的单价为本次谈定单价，仅本次报价生效。'), esc(''), esc(''), esc(''), esc(''), esc(''), esc(''), esc(''), esc('')],
    ];
    downloadBlob(new Blob([`\ufeff${rows.map((r) => r.join(','))}\n`], { type: 'text/csv;charset=utf-8' }), `${project || '全屋智能'}-报价单.csv`);
    message.success('报价单已导出');
  };

  /** 导出 Excel：HTML 表格包成 .xls，Excel/WPS 可直接打开，但不是原生 xls 二进制格式 */
  const exportExcel = (): void => {
    if (!lines.length) {
      message.warning('请先添加产品');
      return;
    }
    const modeLabel = mode === 'retail' ? '官方指导价' : '工程价';
    const esc = (v: string | number): string => String(v).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    const cell = (v: string | number, tag: 'td' | 'th'): string => `<${tag}>${esc(v)}</${tag}>`;
    const row = (cells: Array<string | number>, tag: 'td' | 'th' = 'td'): string => `<tr>${cells.map((c) => cell(c, tag)).join('')}</tr>`;
    const head = (cells: Array<string | number>, span: number): string => `<tr><th colspan="${span}">${esc(cells.join('　　'))}</th></tr>`;
    const body = lines.map((l, i) =>
      row([
        i + 1,
        l.room,
        l.product.name,
        l.product.spec,
        l.qty,
        l.product.unit || '台',
        plainNum(lineSellPrice(l, mode)),
        plainNum(lineSellPrice(l, mode) * l.qty),
        l.note || (l.unitPrice != null ? `本次单价（标准价 ${plainNum(sellPrice(l.product, mode))}）` : ''),
      ]),
    );
    const html = [
      '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">',
      `<title>${esc(project || '全屋智能')}-报价单</title></head><body>`,
      '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:12px">',
      head([`${project || '全屋智能'} 方案报价单`], 9),
      head([`客户：${customer || '未填写'}`, `计价口径：${modeLabel}`, `设备合计：${totals.count} 件`, `导出时间：${new Date().toLocaleString('zh-CN')}`], 9),
      row(['序号', '房间', '产品名称', '规格', '数量', '单位', '单价', '小计', '备注'], 'th'),
      ...body,
      row(['', '', '', '', '', '合计', plainNum(totals.sell), '', ''], 'th'),
      head(['以上价格不含安装辅材与人工，实际成交价以合同为准；标注「本次单价」的行为逐项谈定价，仅本次报价生效。'], 9),
      '</table></body></html>',
    ].join('');
    downloadBlob(new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel' }), `${project || '全屋智能'}-报价单.xls`);
    message.success('报价单已导出（Excel 可直接打开）');
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

  /** 同 family 的多成员产品按 id 记下变体总数，选品区据此提示「N 个规格」 */
  const groups = useMemo(() => variantGroups(products), [products]);
  const variantCount = useMemo(() => {
    const count = new Map<string, number>();
    for (const list of groups.values()) for (const p of list) count.set(p.id, list.length);
    return count;
  }, [groups]);

  const variantLine = lines.find((l) => l.product.id === variantLineId) ?? null;
  const priceLine = lines.find((l) => l.product.id === priceLineId) ?? null;

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="智能报价"
        description="从产品库选品配单，同一产品可换规格、可逐项谈定单价，按官方指导价或工程价切换计价口径，自动测算经销成本、毛利与多级返利，导出标准报价单"
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
            <Button icon={<FileExcelOutlined />} disabled={!lines.length} onClick={exportExcel}>
              导出 Excel
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
                      {variantCount.get(p.id) ? ` · ${variantCount.get(p.id)} 个规格` : ''}
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
                scroll={{ x: isNarrow ? 820 : 1080 }}
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
                  {
                    title: mode === 'retail' ? '指导价单价' : '工程价单价',
                    width: 132,
                    align: 'right',
                    render: (_, l) => (
                      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                        <div>
                          <Text strong style={l.unitPrice != null ? { color: token.colorPrimary } : undefined}>
                            ¥{money(lineSellPrice(l, mode))}
                          </Text>
                        </div>
                        {l.unitPrice != null ? (
                          <div>
                            <Tag color="blue" style={{ marginInlineEnd: 6 }}>已改价</Tag>
                            <Link onClick={() => resetUnitPrice(l.product.id)} style={{ fontSize: 11 }}>恢复标准价</Link>
                          </div>
                        ) : (
                          <div><Text type="secondary" style={{ fontSize: 11 }}>标准价 ¥{sellPrice(l.product, mode)}</Text></div>
                        )}
                      </div>
                    ),
                  },
                  { title: '经销成本', width: 92, align: 'right', render: (_, l) => <Text type="success">¥{costPrice(l.product)}</Text> },
                  {
                    title: '房间 / 备注',
                    width: isNarrow ? 128 : 156,
                    render: (_, l) => (
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Input
                          value={l.room}
                          onChange={(e) => setLineText(l.product.id, { room: e.target.value })}
                          placeholder="房间"
                          size="small"
                          maxLength={12}
                          style={{ fontSize: 12 }}
                        />
                        <Input
                          value={l.note}
                          onChange={(e) => setLineText(l.product.id, { note: e.target.value })}
                          placeholder="备注"
                          size="small"
                          maxLength={30}
                          style={{ fontSize: 12 }}
                        />
                      </Space>
                    ),
                  },
                  {
                    title: '小计 / 毛利',
                    width: 150,
                    align: 'right',
                    render: (_, l) => (
                      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                        <div><Text strong>¥{money(lineSellPrice(l, mode) * l.qty)}</Text></div>
                        <div><Text type="secondary">毛利 ¥{money((lineSellPrice(l, mode) - costPrice(l.product)) * l.qty)}</Text></div>
                      </div>
                    ),
                  },
                  {
                    title: '操作',
                    width: 124,
                    render: (_, l) => (
                      <Space size={4} wrap>
                        <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openPrice(l)} style={{ paddingInline: 4 }}>改单价</Button>
                        {variantSiblings(groups, l.product).length ? (
                          <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => setVariantLineId(l.product.id)} style={{ paddingInline: 4 }}>换规格</Button>
                        ) : null}
                      </Space>
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
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                逐项单价仅本次生效：它只存在于本页草稿，刷新页面即失效，也不会写回产品库；导出的 Excel 为 HTML 表格格式，Excel / WPS 可直接打开（不是原生 xls 二进制）。
              </Text>
            </>
          )}
        </Card>
      </div>

      {/* 换规格：列出同 family 全部变体，点击替换当前行的产品 */}
      <Modal
        title={`换规格 · ${variantLine ? variantMeta(variantLine.product.name).base : ''}`}
        open={!!variantLine}
        onCancel={() => setVariantLineId(null)}
        footer={null}
        width={isNarrow ? '92vw' : 520}
        destroyOnHidden
      >
        <Text type="secondary" style={{ fontSize: 12 }}>选择规格替换本行产品，数量与房间保持不变</Text>
        <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8, maxHeight: '46vh', overflowY: 'auto' }}>
          {(variantLine ? variantFamily(groups, variantLine.product) : []).map((p) => {
            const current = variantLine?.product.id === p.id;
            return (
              <Button
                key={p.id}
                block
                onClick={() => switchVariant(p)}
                style={{
                  height: 'auto',
                  padding: '8px 10px',
                  whiteSpace: 'normal',
                  textAlign: 'left',
                  background: current ? token.colorPrimaryBg : undefined,
                  borderColor: current ? token.colorPrimary : undefined,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                  <span style={{ fontSize: 12, flexShrink: 0 }}>¥{sellPrice(p, mode)}/{p.unit || '台'}</span>
                </div>
                <div style={{ fontSize: 11, opacity: 0.65 }}>
                  {[p.spec, p.sku ? `SKU ${p.sku}` : '', current ? '当前规格' : ''].filter(Boolean).join(' · ')}
                </div>
              </Button>
            );
          })}
        </Space>
      </Modal>

      {/* 逐项单价覆盖：显示参考价区间，只填本次谈定价 */}
      <Modal
        title={`改单价 · ${priceLine?.product.name ?? ''}`}
        open={!!priceLine}
        onCancel={() => setPriceLineId(null)}
        onOk={savePrice}
        okText="应用"
        cancelText="取消"
        width={isNarrow ? '92vw' : 440}
        destroyOnHidden
      >
        {priceLine ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              参考价区间 ¥{priceLine.product.priceMin} ~ ¥{priceLine.product.priceMax}；当前
              {mode === 'retail' ? '指导价' : '工程价'} ¥{sellPrice(priceLine.product, mode)}，经销成本 ¥{costPrice(priceLine.product)}。
            </Text>
            <InputNumber
              value={priceDraft}
              onChange={(v) => setPriceDraft(v == null ? null : Number(v))}
              min={0}
              precision={2}
              step={10}
              placeholder={`本次单价，留空则按标准价 ¥${sellPrice(priceLine.product, mode)}`}
              style={{ width: '100%' }}
              addonBefore="¥"
            />
            <Text type="secondary" style={{ fontSize: 11 }}>逐项单价仅本次报价生效，不改产品库标准价。</Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
