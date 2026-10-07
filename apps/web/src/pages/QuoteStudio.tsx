import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, Button, Card, Input, InputNumber, Space, Table, Tag, Typography } from 'antd';
import { api } from '../lib/api';
import { catMeta } from '../lib/pointOverlay';

const { Title, Text } = Typography;

interface Product {
  id: string;
  name: string;
  category: string;
  priceMin: number;
  priceMax: number;
  perRoom: string;
}

interface Line {
  product: Product;
  qty: number;
}

function money(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : `${n.toLocaleString('zh-CN')}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 智能报价：产品库选品配单，按数量与参考价区间自动算价，导出报价单 CSV（合规：区间+现场确认为准） */
export function QuoteStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [project, setProject] = useState('');
  const [customer, setCustomer] = useState('');

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
    const min = lines.reduce((s, l) => s + l.product.priceMin * l.qty, 0);
    const max = lines.reduce((s, l) => s + l.product.priceMax * l.qty, 0);
    const count = lines.reduce((s, l) => s + l.qty, 0);
    return { min, max, count };
  }, [lines]);

  const exportCsv = (): void => {
    if (!lines.length) {
      message.warning('请先添加产品');
      return;
    }
    const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [
      [esc('全屋智能方案报价单'), esc(project || '未命名项目'), esc(''), esc(''), esc('')],
      [esc('客户'), esc(customer || ''), esc('生成日期'), esc(new Date().toISOString().slice(0, 10)), esc('')],
      [esc(''), esc(''), esc(''), esc(''), esc('')],
      [esc('品类'), esc('产品名称'), esc('数量'), esc('小计区间(元)'), esc('单价区间(元)')],
      ...lines.map((l) => [
        esc(catMeta(l.product.category).label),
        esc(l.product.name),
        l.qty,
        esc(`${(l.product.priceMin * l.qty).toLocaleString('zh-CN')} - ${(l.product.priceMax * l.qty).toLocaleString('zh-CN')}`),
        esc(`${l.product.priceMin}-${l.product.priceMax}`),
      ]),
      [esc(''), esc('合计'), totals.count, esc(`${totals.min.toLocaleString('zh-CN')} - ${totals.max.toLocaleString('zh-CN')}`), esc('')],
      [esc(''), esc(''), esc(''), esc(''), esc('')],
      [esc('说明'), esc('以上为设备参考价区间，不含安装辅材与人工；实际报价以门店方案师现场确认为准。'), esc(''), esc(''), esc('')],
    ];
    downloadBlob(new Blob([`\ufeff${rows.map((r) => r.join(',')).join('\n')}`], { type: 'text/csv;charset=utf-8' }), `${project || '全屋智能'}-报价单.csv`);
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
    <div style={{ paddingBottom: 24 }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ marginBottom: 4 }}>智能报价</Title>
        <Text type="secondary" style={{ fontSize: 13 }}>从产品库选品配单，按数量与参考价区间自动算价，一键导出报价单（价格区间口径，实际以现场确认为准）。</Text>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 左：产品库 */}
        <Card title="产品库（点击加入报价单）" style={{ width: 320, flexShrink: 0 }} styles={{ body: { padding: '12px 16px', maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}>
          {grouped.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 12 }}>
              <Tag color={catMeta(cat).color} style={{ marginBottom: 6 }}>{catMeta(cat).label}</Tag>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {list.map((p) => (
                  <Button key={p.id} block size="small" style={{ textAlign: 'left', height: 'auto', padding: '4px 10px', whiteSpace: 'normal' }} onClick={() => addProduct(p)}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.65 }}>¥{p.priceMin}-{p.priceMax} · {p.perRoom || '按需'}</div>
                  </Button>
                ))}
              </Space>
            </div>
          ))}
        </Card>

        {/* 右：报价单 */}
        <Card
          style={{ flex: '1 1 560px', minWidth: 340 }}
          title={
            <Space wrap>
              <Input value={project} onChange={(e) => setProject(e.target.value)} maxLength={40} placeholder="项目名" style={{ width: 180 }} size="small" />
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={20} placeholder="客户称呼" style={{ width: 140 }} size="small" />
            </Space>
          }
          extra={
            <Space>
              <Text strong style={{ fontSize: 14 }}>合计 <span style={{ color: catMeta('light').color }}>¥{money(totals.min)} - {money(totals.max)}</span></Text>
              <Button type="primary" size="small" disabled={!lines.length} onClick={exportCsv}>导出报价单 CSV</Button>
            </Space>
          }
        >
          {lines.length === 0 ? (
            <Text type="secondary">报价单为空，从左侧产品库点击添加设备。</Text>
          ) : (
            <Table<Line>
              rowKey={(l) => l.product.id}
              dataSource={lines}
              pagination={false}
              size="small"
              columns={[
                { title: '品类', render: (_, l) => catMeta(l.product.category).label, width: 96 },
                { title: '产品', render: (_, l) => l.product.name },
                { title: '单价区间', render: (_, l) => `¥${l.product.priceMin}-${l.product.priceMax}`, width: 120 },
                { title: '数量', render: (_, l) => <InputNumber min={0} max={999} value={l.qty} onChange={(v) => setQty(l.product.id, Number(v ?? 0))} size="small" style={{ width: 72 }} />, width: 96 },
                { title: '小计区间', render: (_, l) => `¥${money(l.product.priceMin * l.qty)}-${money(l.product.priceMax * l.qty)}`, width: 150 },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
