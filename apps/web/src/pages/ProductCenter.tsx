import { AppstoreOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RobotOutlined, ShopOutlined } from '@ant-design/icons';
import { App as AntApp, AutoComplete, Button, Card, Col, ColorPicker, Divider, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography, Upload, theme } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fileUrl } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { catMeta, categoryList, categoryOptions, loadCategoryDict, refreshCategoryDict, type CategoryDef } from '../lib/categoryStore';
import { compressImage } from '../lib/compress';
import { categoryIconSvg, iconSvgByKey, productIconSvg, ICON_SIZE, PRODUCT_ICON_KEYS } from '../lib/product-icons';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text } = Typography;

interface ProductRow {
  iconKey?: string;
  id: string;
  tenantId: string | null;
  name: string;
  category: string;
  brand: string;
  model: string;
  unit: string;
  imageUrl: string;
  priceMin: number;
  priceMax: number;
  perRoom: string;
  sku: string;
  barcode: string;
  snRule: string;
  spec: string;
  warranty: number;
  priceRetail: number;
  priceDealer: number;
  priceProject: number;
  rebateL1: number;
  rebateL2: number;
  rebateDesigner: number;
}

interface ProductForm {
  name: string;
  category: string;
  brand?: string;
  model?: string;
  unit?: string;
  perRoom?: string;
  imageUrl?: string;
  sku?: string;
  barcode?: string;
  snRule?: string;
  spec?: string;
  warranty?: number;
  priceRetail?: number;
  priceDealer?: number;
  priceProject?: number;
  rebateL1?: number;
  rebateL2?: number;
  rebateDesigner?: number;
}

const COLOR_CHOICES = ['#4FA8E0', '#5BA86B', '#D9A036', '#8E7CC3', '#D06A5A', '#5AA8A0', '#C37FB0', '#7A8CA8', '#B07A4A', '#4A90A8'];

/**
 * 产品中心（公共库与我的库）：
 * 公共库=平台种子（示例产品 + 39 预置品类），可复制到我的库、可直接传产品图；
 * 我的库=本租户 CRUD（含产品图上传、知识库产品资料自动同步）。
 * 联动规则：点位编辑器与智能报价的产品来源 = 公共库 + 我的库；
 * 产品图即点位图标（编辑器优先用产品照片，无图回退品类 lucide 图标）。
 */
export function ProductCenter(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'public' | 'mine'>('public');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string | undefined>();
  const [brandFilter, setBrandFilter] = useState<string | undefined>();
  const [dictVersion, setDictVersion] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [catBusy, setCatBusy] = useState(false);
  const [catIconOpen, setCatIconOpen] = useState(false);
  const [form] = Form.useForm<ProductForm>();
  const [catForm] = Form.useForm<{ label: string; icon: string; color: string | { toHexString?: () => string } }>();

  const reload = useCallback(async (): Promise<void> => {
    setRows(await api<ProductRow[]>('/api/products'));
  }, []);

  useEffect(() => {
    void loadCategoryDict().then(() => setDictVersion((v) => v + 1));
    reload().catch((e) => message.error((e as Error).message)).finally(() => setLoading(false));
  }, [reload, message]);

  const catOptions = useMemo(() => categoryOptions(), [dictVersion]);
  const catList = useMemo(() => categoryList(), [dictVersion]);
  const brandOptions = useMemo(
    () => [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh')).map((b) => ({ value: b })),
    [rows],
  );

  const data = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === 'public' ? r.tenantId !== null : r.tenantId === null) return false;
      if (catFilter && r.category !== catFilter) return false;
      if (brandFilter && r.brand !== brandFilter) return false;
      if (kw && !`${r.name}${r.brand}${r.model}${r.sku}${r.barcode}${r.snRule}${r.spec}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [rows, tab, search, catFilter, brandFilter]);

  const publicCount = rows.filter((r) => r.tenantId === null).length;
  const mineCount = rows.length - publicCount;

  const openEdit = (row?: ProductRow): void => {
    setEditing(row ?? null);
    form.setFieldsValue(
      row
        ? {
            name: row.name, category: row.category, brand: row.brand, model: row.model, unit: row.unit,
            perRoom: row.perRoom, imageUrl: row.imageUrl,
            sku: row.sku, barcode: row.barcode, snRule: row.snRule, spec: row.spec, warranty: row.warranty,
            priceRetail: row.priceRetail, priceDealer: row.priceDealer, priceProject: row.priceProject,
            rebateL1: row.rebateL1, rebateL2: row.rebateL2, rebateDesigner: row.rebateDesigner,
          }
        : {
            category: 'gateway', unit: '台', imageUrl: '', warranty: 12,
            priceRetail: 0, priceDealer: 0, priceProject: 0, rebateL1: 0, rebateL2: 0, rebateDesigner: 0,
          },
    );
    setEditOpen(true);
  };

  const saveProduct = async (): Promise<void> => {
    let values: ProductForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const dealer = values.priceDealer ?? 0;
    const project = values.priceProject ?? 0;
    const retail = values.priceRetail ?? 0;
    if (dealer > project && project > 0) {
      message.warning('经销价不应高于工程价，请核对三级价格');
      return;
    }
    if (project > retail && retail > 0) {
      message.warning('工程价不应高于官方指导价，请核对三级价格');
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({ ...values, name: values.name.trim() });
      if (editing) await api(`/api/products/${editing.id}`, { method: 'PATCH', body });
      else await api('/api/products/mine', { method: 'POST', body });
      message.success(editing ? '已保存' : '已加入我的产品库');
      setEditOpen(false);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const copyToMine = async (row: ProductRow): Promise<void> => {
    try {
      await api(`/api/products/${row.id}/copy-to-mine`, { method: 'POST' });
      message.success(`「${row.name}」已加入我的产品库`);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const removeMine = async (row: ProductRow): Promise<void> => {
    try {
      await api(`/api/products/${row.id}`, { method: 'DELETE' });
      message.success('已删除');
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 上传产品图：先 canvas 压缩+中心裁切为正方形（1:1 点位图标口径），再传 /api/media/uploads */
  const uploadProductImage = async (file: File, title: string): Promise<{ id: string; url: string } | null> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP');
      return null;
    }
    try {
      const compressed = await compressImage(file, { square: true });
      const fd = new FormData();
      fd.append('file', compressed);
      fd.append('title', title.slice(0, 40));
      return await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
    } catch (e) {
      message.error((e as Error).message);
      return null;
    }
  };

  /** 任意行（含公共库）快速更换产品图：只 PATCH imageUrl，产品图即点位图标 */
  const quickUploadImage = async (row: ProductRow, file: File): Promise<boolean> => {
    const res = await uploadProductImage(file, `产品图-${row.name}`);
    if (!res) return false;
    try {
      await api(`/api/products/${row.id}`, { method: 'PATCH', body: JSON.stringify({ imageUrl: res.url }) });
      message.success(`「${row.name}」产品图已更新`);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
    return false;
  };

  /** agent 批量处理：勾选行一次补全文案/品类归位 + 批量生成产品图（生图按张扣额度） */
  const aiProcess = (): void => {
    if (!selectedIds.length) {
      message.warning('请先勾选要处理的产品');
      return;
    }
    modal.confirm({
      title: `AI 批量处理 ${selectedIds.length} 个产品？`,
      content: '智能体将补全缺失的品牌/型号/布置提示、按品类字典归位分类，并生成白底产品主图（产品图即点位图标）。生图按张扣减额度，单个失败不影响其余。',
      okText: '开始处理',
      cancelText: '取消',
      onOk: async () => {
        setAiBusy(true);
        try {
          const r = await api<{ total: number; copyOk: number; imageOk: number; errors: { name: string; error: string }[] }>('/api/products/ai-process', {
            method: 'POST',
            body: JSON.stringify({ ids: selectedIds }),
          });
          const failNote = r.errors.length ? `，${r.errors.length} 个生图失败（${r.errors[0]?.error?.slice(0, 40) ?? ''}）` : '';
          message.success(`处理完成：文案/分类修正 ${r.copyOk} 项、产品图生成 ${r.imageOk} 项${failNote}`);
          setSelectedIds([]);
          await reload();
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setAiBusy(false);
        }
      },
    });
  };

  const uploadImage = async (file: File): Promise<boolean> => {
    const res = await uploadProductImage(file, file.name.replace(/\.[^.]+$/, ''));
    if (!res) return false;
    form.setFieldValue('imageUrl', res.url);
    message.success('产品图已上传（已自动压缩）');
    return false;
  };

  /** 新增自定义分类（同名幂等；成功后刷新字典） */
  const addCategory = async (): Promise<void> => {
    let values: { label: string; icon: string; color: string | { toHexString?: () => string } };
    try {
      values = await catForm.validateFields();
    } catch {
      return;
    }
    setCatBusy(true);
    try {
      const color = typeof values.color === 'string' ? values.color : values.color?.toHexString?.() ?? '#888888';
      const created = await api<CategoryDef>('/api/categories/mine', {
        method: 'POST',
        body: JSON.stringify({ label: values.label.trim(), icon: values.icon, color }),
      });
      await refreshCategoryDict();
      setDictVersion((v) => v + 1);
      message.success(`分类「${created.label}」已添加`);
      catForm.resetFields();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCatBusy(false);
    }
  };

  const removeCategory = async (c: CategoryDef): Promise<void> => {
    try {
      await api(`/api/categories/${c.id}`, { method: 'DELETE' });
      await refreshCategoryDict();
      setDictVersion((v) => v + 1);
      message.success(`分类「${c.label}」已删除`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const thumb = (r: ProductRow): ReactNode =>
    r.imageUrl ? (
      <Image src={fileUrl(r.imageUrl)} width={40} height={40} style={{ borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(0,0,0,.06)' }} />
    ) : (
      <span style={{ width: 40, height: 40, borderRadius: 8, background: `${catMeta(r.category).color}1a`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: productIconSvg(r.category, r.iconKey, ICON_SIZE.thumb, catMeta(r.category).color) }} />
    );

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="产品中心"
        description="标准产品主数据：SKU/条码/SN 规则/规格质保 + 三级价格（指导价/工程价/经销价）+ 多级返利（一级/二级/设计师），联动智能报价、设备点位与知识库产品资料"
        extra={
          <Space wrap>
            <Button onClick={() => navigate('/quote')}>智能报价</Button>
            <Button onClick={() => navigate('/device-layout')}>设备点位</Button>
            <Button icon={<AppstoreOutlined />} onClick={() => setCatOpen(true)}>分类管理</Button>
            <Button type="primary" icon={<PlusOutlined />} style={{ background: BRAND_GRADIENT, border: 'none' }} onClick={() => openEdit()}>
              新增我的产品
            </Button>
            <Button icon={<RobotOutlined />} loading={aiBusy} disabled={!selectedIds.length} onClick={aiProcess}>
              AI 批量处理{selectedIds.length ? `（${selectedIds.length}）` : ''}
            </Button>
          </Space>
        }
      />

      <Card styles={{ body: { padding: '16px 20px 20px' } }}>
        <Space wrap style={{ marginBottom: 14 }} size={12}>
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as 'public' | 'mine')}
            options={[
              { label: `公共产品库 ${publicCount}`, value: 'public' },
              { label: `我的产品库 ${mineCount}`, value: 'mine' },
            ]}
          />
          <Input.Search placeholder="搜索名称 / 品牌 / 型号 / SKU / 条码 / SN" allowClear style={{ width: 260 }} onChange={(e) => setSearch(e.target.value)} />
          <Select placeholder="全部分类" allowClear style={{ width: 150 }} value={catFilter} onChange={setCatFilter} options={catOptions} />
          <Select placeholder="全部品牌" allowClear showSearch style={{ width: 150 }} value={brandFilter} onChange={setBrandFilter} options={brandOptions} />
        </Space>

        <Table<ProductRow>
          rowKey="id"
          loading={loading}
          dataSource={data}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys as string[]),
          }}
          pagination={{ pageSize: 12, hideOnSinglePage: true, showSizeChanger: false }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === 'mine' ? '我的库暂无产品：从公共库「复制到我的库」、点右上角新增，或在「内容提取」上传产品资料自动入库' : '无匹配产品'} /> }}
          scroll={{ x: 1680 }}
          columns={[
            {
              title: '产品',
              width: 210,
              render: (_, r) => (
                <Space size={10}>
                  {thumb(r)}
                  <div style={{ minWidth: 0 }}>
                    <Space size={4}>
                      <Text strong ellipsis style={{ maxWidth: 140 }}>{r.name}</Text>
                      {r.tenantId ? <Tag color="green" style={{ marginInlineEnd: 0 }}>我的</Tag> : null}
                    </Space>
                    <div><Text type="secondary" style={{ fontSize: 11 }}>SKU {r.sku || '—'}</Text></div>
                  </div>
                </Space>
              ),
            },
            { title: '分类', dataIndex: 'category', width: 96, render: (v: string) => <Tag color={catMeta(v).color} style={{ marginInlineEnd: 0 }}>{catMeta(v).label}</Tag> },
            { title: '品牌/型号', width: 140, render: (_, r) => <Text type="secondary" style={{ fontSize: 12 }}>{[r.brand, r.model].filter(Boolean).join(' · ') || '-'}</Text> },
            { title: '商品条码', dataIndex: 'barcode', width: 132, render: (v: string) => (v ? <Text copyable={{ text: v, tooltips: false }} style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">—</Text>) },
            { title: 'SN 码规则', dataIndex: 'snRule', width: 110, render: (v: string) => v ? <Text code style={{ fontSize: 11 }}>{v}****</Text> : <Text type="secondary">—</Text> },
            { title: '规格参数', dataIndex: 'spec', width: 200, ellipsis: true, render: (v: string) => <Tooltip title={v}><Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text></Tooltip> },
            { title: '质保', dataIndex: 'warranty', width: 64, align: 'center', render: (m: number) => (m >= 12 && m % 12 === 0 ? `${m / 12} 年` : `${m} 月`) },
            {
              title: '指导价 / 工程价 / 经销价',
              width: 182,
              sorter: (a, b) => a.priceRetail - b.priceRetail,
              render: (_, r) => (
                <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                  <div><Text type="secondary">指导</Text> <Text strong>¥{r.priceRetail || 0}</Text></div>
                  <div><Text type="secondary">工程</Text> <Text>¥{r.priceProject || r.priceMin || 0}</Text></div>
                  <div><Text type="secondary">经销</Text> <Text type="success">¥{r.priceDealer || 0}</Text></div>
                </div>
              ),
            },
            {
              title: '多级返利（一级/二级/设计师）',
              width: 168,
              render: (_, r) => (
                <Space size={3} wrap>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{r.rebateL1}%</Tag>
                  <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{r.rebateL2}%</Tag>
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>{r.rebateDesigner}%</Tag>
                </Space>
              ),
            },
            { title: '布置提示', dataIndex: 'perRoom', width: 150, ellipsis: true, render: (v: string) => <Tooltip title={v}><Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text></Tooltip> },
            {
              title: '操作',
              width: 168,
              fixed: 'right' as const,
              render: (_, r) =>
                r.tenantId === null ? (
                  <Space size={4}>
                    <Upload accept="image/jpeg,image/png,image/webp" showUploadList={false} beforeUpload={(f) => void quickUploadImage(r, f)}>
                      <Button size="small" type="text" icon={<PlusOutlined />}>传图</Button>
                    </Upload>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => void copyToMine(r)}>复制到我的库</Button>
                  </Space>
                ) : (
                  <Space size={4}>
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                    <Popconfirm title={`删除「${r.name}」？`} onConfirm={() => void removeMine(r)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ),
            },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
          <ShopOutlined /> 联动规则：设备/灯光点位与智能报价的选品来源 = 公共库 + 我的库；每个产品都可上传自己的 PNG/JPG 主图（自动压缩至 1024px，产品图即点位图标，无图回退品类图标）；「内容提取」确认的产品资料自动同步到我的库；勾选产品后「AI 批量处理」由智能体补全文案、归位分类并批量生成产品主图。
        </Text>
      </Card>

      <Modal title={editing ? `编辑「${editing.name}」` : '新增我的产品'} open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => void saveProduct()} okText="保存" confirmLoading={saving} destroyOnHidden width={720}>
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Divider titlePlacement="left" style={{ fontSize: 13, margin: '4px 0 12px' }}>基本信息</Divider>
          <Row gutter={12}>
            <Col span={15}>
              <Form.Item name="name" label="产品名称" rules={[{ required: true, message: '必填' }, { max: 60 }]}>
                <Input placeholder="如：智能中控屏 Pro" />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="category" label="分类" rules={[{ required: true }]}>
                <Select options={catOptions} showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="brand" label="品牌">
                <AutoComplete options={brandOptions} placeholder="选择已有或输入新品牌" maxLength={40} filterOption={(i, o) => (o?.value ?? '').toLowerCase().includes(i.toLowerCase())} />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="model" label="型号"><Input maxLength={40} placeholder="如 X1-Pro" /></Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="unit" label="计量单位"><Input maxLength={10} placeholder="台/套/个" /></Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="spec" label="规格参数" extra="协议/尺寸/供电等一行摘要，报价单与点位清单引用">
                <Input maxLength={120} placeholder="如：Zigbee 3.0 · 86 型暗装 · 单路 600W" />
              </Form.Item>
            </Col>
            <Col span={15}>
              <Form.Item name="perRoom" label="布置提示"><Input maxLength={60} placeholder="如：每个窗帘位 1 台" /></Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="warranty" label="质保期（月）">
                <InputNumber min={0} max={600} step={12} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider titlePlacement="left" style={{ fontSize: 13, margin: '4px 0 12px' }}>编码标识</Divider>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="sku" label="商品编码 SKU" extra="门店内部订货号">
                <Input maxLength={40} placeholder="如 GW-1001" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="barcode" label="商品条码" extra="EAN-13/UPC，无则留空">
                <Input maxLength={20} placeholder="13 位数字" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="snRule" label="SN 码规则" extra="交付设备序列号前缀">
                <Input maxLength={40} placeholder="如 SJ-GW-" />
              </Form.Item>
            </Col>
          </Row>

          <Divider titlePlacement="left" style={{ fontSize: 13, margin: '4px 0 12px' }}>价格体系与多级返利</Divider>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="priceRetail" label="官方指导价（元）" extra="零售挂牌价/对外报价">
                <InputNumber min={0} max={10_000_000} style={{ width: '100%' }} prefix="¥" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priceProject" label="工程价（元）" extra="批量/渠道成交价">
                <InputNumber min={0} max={10_000_000} style={{ width: '100%' }} prefix="¥" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priceDealer" label="经销价（元）" extra="门店进货成本">
                <InputNumber min={0} max={10_000_000} style={{ width: '100%' }} prefix="¥" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="rebateL1" label="一级经销返点" extra="总代/一级渠道返点比例">
                <InputNumber min={0} max={100} style={{ width: '100%' }} addonAfter="%" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="rebateL2" label="二级分销返点" extra="门店/分销层级返点比例">
                <InputNumber min={0} max={100} style={{ width: '100%' }} addonAfter="%" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="rebateDesigner" label="设计师返点" extra="设计师/介绍人返点比例">
                <InputNumber min={0} max={100} style={{ width: '100%' }} addonAfter="%" />
              </Form.Item>
            </Col>
          </Row>

          <Divider titlePlacement="left" style={{ fontSize: 13, margin: '4px 0 12px' }}>产品图</Divider>
          <Form.Item name="imageUrl">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Upload accept="image/jpeg,image/png,image/webp" showUploadList={false} beforeUpload={(f) => void uploadImage(f)}>
                <Button icon={<PlusOutlined />}>上传产品图（自动压缩，1:1 方形）</Button>
              </Upload>
              <Form.Item noStyle shouldUpdate>
                {() => {
                  const u = form.getFieldValue('imageUrl');
                  return u ? <Text type="secondary" style={{ fontSize: 12 }}>已上传：{u.split('/').pop()}，重新上传可替换；产品图即点位图标</Text> : <Text type="secondary" style={{ fontSize: 12 }}>不上传则点位显示品类图标</Text>;
                }}
              </Form.Item>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="分类管理" open={catOpen} onCancel={() => setCatOpen(false)} footer={null} destroyOnHidden width={560}>
        <Text type="secondary" style={{ fontSize: 12 }}>预置 {catList.filter((c) => c.tenantId === null).length} 类覆盖市面主流智能家居品类；可按你的业务补充自定义分类（点位图标复用预置图标库）。</Text>
        <Form form={catForm} layout="vertical" initialValues={{ icon: 'radar', color: '#888888' }} style={{ marginTop: 12 }}>
          <Space.Compact block>
            <Form.Item name="label" label="新增分类名称" rules={[{ required: true, message: '必填' }, { max: 20 }]} style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="如：适老照护" />
            </Form.Item>
            <Form.Item name="icon" label="图标（57 款）" style={{ width: 130, marginRight: 8 }}>
              <Select
                open={catIconOpen}
                onDropdownVisibleChange={setCatIconOpen}
                options={PRODUCT_ICON_KEYS.map((k) => ({ value: k, label: k }))}
                popupMatchSelectWidth={false}
                dropdownStyle={{ width: 348, padding: 8 }}
                labelRender={({ value }) => (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span dangerouslySetInnerHTML={{ __html: iconSvgByKey(String(value), ICON_SIZE.medium, '#555') }} />
                    <Text type="secondary" style={{ fontSize: 11 }}>{String(value)}</Text>
                  </span>
                )}
                dropdownRender={() => (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, maxHeight: 248, overflowY: 'auto' }}>
                    {PRODUCT_ICON_KEYS.map((k) => {
                      const selected = catForm.getFieldValue('icon') === k;
                      return (
                        <span
                          key={k}
                          title={k}
                          onClick={() => { catForm.setFieldValue('icon', k); setCatIconOpen(false); }}
                          style={{
                            display: 'inline-flex', width: 32, height: 32, borderRadius: 8,
                            alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                            background: selected ? token.colorPrimaryBg : 'transparent',
                            boxShadow: selected ? `inset 0 0 0 1px ${token.colorPrimary}` : 'none',
                          }}
                          dangerouslySetInnerHTML={{ __html: iconSvgByKey(k, ICON_SIZE.medium, selected ? token.colorPrimary : '#555') }}
                        />
                      );
                    })}
                  </div>
                )}
              />
            </Form.Item>
            <Form.Item name="color" label="颜色" style={{ width: 100 }}>
              <ColorPicker presets={[{ label: '推荐', colors: COLOR_CHOICES }]} showText format="hex" disabledAlpha />
            </Form.Item>
          </Space.Compact>
          <Button type="primary" loading={catBusy} onClick={() => void addCategory()} block>添加自定义分类</Button>
        </Form>
        <div style={{ maxHeight: 300, overflowY: 'auto', marginTop: 14 }}>
          <Table<CategoryDef>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={catList}
            columns={[
              // 图标给固定 32×32 居中盒子：原来 span 只有 inline-flex，在 44px 列里靠左，与右侧文字列视觉不齐
              { title: '', width: 44, align: 'center', render: (_, c) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, background: `${c.color}14`, color: c.color, flex: 'none' }} dangerouslySetInnerHTML={{ __html: iconSvgByKey(c.icon, ICON_SIZE.medium, c.color) }} />
              ) },
              { title: '分类', render: (_, c) => <Space size={6}><Text>{c.label}</Text>{c.tenantId ? <Tag color="green">自定义</Tag> : null}</Space> },
              { title: 'key', dataIndex: 'key', width: 120, render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> },
              {
                title: '操作',
                width: 64,
                render: (_, c) =>
                  c.tenantId ? (
                    <Popconfirm title={`删除分类「${c.label}」？`} onConfirm={() => void removeCategory(c)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ) : null,
              },
            ]}
          />
        </div>
      </Modal>
    </div>
  );
}
