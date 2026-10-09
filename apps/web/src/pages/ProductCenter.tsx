import { AppstoreOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RobotOutlined, ShopOutlined } from '@ant-design/icons';
import { App as AntApp, AutoComplete, Button, Card, ColorPicker, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fileUrl } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { catMeta, categoryList, categoryOptions, loadCategoryDict, refreshCategoryDict, type CategoryDef } from '../lib/categoryStore';
import { compressImage } from '../lib/compress';
import { categoryIconSvg, iconSvgByKey } from '../lib/product-icons';
import { BRAND_GRADIENT, pageContainerStyle } from '../theme/tokens';

const { Text } = Typography;

interface ProductRow {
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
}

interface ProductForm {
  name: string;
  category: string;
  brand?: string;
  model?: string;
  unit?: string;
  priceMin?: number;
  priceMax?: number;
  perRoom?: string;
  imageUrl?: string;
}

/** 自定义分类可选的图标（lucide kebab key，与预置字典一致） */
const ICON_CHOICES = ['router', 'wifi', 'toggle-right', 'cable', 'radar', 'bell-ring', 'droplets', 'thermometer', 'lamp', 'blinds', 'lock', 'cctv', 'flame', 'washing-machine', 'shower-head', 'bot', 'waves', 'audio-lines', 'projector', 'air-vent', 'fan', 'flower-2', 'paw-print', 'plug'];
const COLOR_CHOICES = ['#4FA8E0', '#5BA86B', '#D9A036', '#8E7CC3', '#D06A5A', '#5AA8A0', '#C37FB0', '#7A8CA8', '#B07A4A', '#4A90A8'];

/**
 * 产品中心（公共库与我的库）：
 * 公共库=平台种子（21 款示例 + 24 预置品类），可复制到我的库、可直接传产品图；
 * 我的库=本租户 CRUD（含产品图上传、知识库产品资料自动同步）。
 * 联动规则：点位编辑器与智能报价的产品来源 = 公共库 + 我的库；
 * 产品图即点位图标（编辑器优先用产品照片，无图回退品类 lucide 图标）。
 */
export function ProductCenter(): ReactNode {
  const { message, modal } = AntApp.useApp();
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
      if (kw && !`${r.name}${r.brand}${r.model}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [rows, tab, search, catFilter, brandFilter]);

  const publicCount = rows.filter((r) => r.tenantId === null).length;
  const mineCount = rows.length - publicCount;

  const openEdit = (row?: ProductRow): void => {
    setEditing(row ?? null);
    form.setFieldsValue(
      row
        ? { name: row.name, category: row.category, brand: row.brand, model: row.model, unit: row.unit, priceMin: row.priceMin, priceMax: row.priceMax, perRoom: row.perRoom, imageUrl: row.imageUrl }
        : { category: 'gateway', unit: '台', priceMin: 0, priceMax: 0, imageUrl: '' },
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

  /** 上传产品图：先 canvas 压缩（最长边 ≤1024），再传 /api/media/uploads */
  const uploadProductImage = async (file: File, title: string): Promise<{ id: string; url: string } | null> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP');
      return null;
    }
    try {
      const compressed = await compressImage(file);
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
      <span style={{ width: 40, height: 40, borderRadius: 8, background: `${catMeta(r.category).color}1a`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: categoryIconSvg(r.category, 20, catMeta(r.category).color) }} />
    );

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="产品中心"
        description="公共库与我的库：24 预置品类 + 自定义分类，上传或复制产品、维护产品图（产品图即点位图标），联动智能报价、设备点位与知识库产品资料"
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
          <Input.Search placeholder="搜索名称 / 品牌 / 型号" allowClear style={{ width: 220 }} onChange={(e) => setSearch(e.target.value)} />
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
          columns={[
            { title: '', dataIndex: 'imageUrl', width: 56, render: (_, r) => thumb(r) },
            { title: '产品名称', dataIndex: 'name', render: (v: string, r) => (
              <Space size={6}>
                <Text strong>{v}</Text>
                {r.tenantId ? <Tag color="green">我的</Tag> : null}
              </Space>
            ) },
            { title: '分类', dataIndex: 'category', width: 120, render: (v: string) => <Tag color={catMeta(v).color}>{catMeta(v).label}</Tag> },
            { title: '品牌/型号', width: 160, render: (_, r) => <Text type="secondary" style={{ fontSize: 12 }}>{[r.brand, r.model].filter(Boolean).join(' · ') || '-'}</Text> },
            { title: '参考价', width: 140, render: (_, r) => `¥${r.priceMin}-${r.priceMax}/${r.unit || '台'}` },
            { title: '布置提示', dataIndex: 'perRoom', ellipsis: true, render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text> },
            {
              title: '操作',
              width: 210,
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

      <Modal title={editing ? `编辑「${editing.name}」` : '新增我的产品'} open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => void saveProduct()} okText="保存" confirmLoading={saving} destroyOnHidden width={520}>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Space.Compact block>
            <Form.Item name="name" label="产品名称" rules={[{ required: true, message: '必填' }, { max: 60 }]} style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="如：智能中控屏 Pro" />
            </Form.Item>
            <Form.Item name="category" label="分类" rules={[{ required: true }]} style={{ width: 150 }}>
              <Select options={catOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="brand" label="品牌" style={{ flex: 1, marginRight: 8 }}>
              <AutoComplete options={brandOptions} placeholder="选择已有或输入新品牌" maxLength={40} filterOption={(i, o) => (o?.value ?? '').toLowerCase().includes(i.toLowerCase())} />
            </Form.Item>
            <Form.Item name="model" label="型号" style={{ flex: 1 }}><Input maxLength={40} /></Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="priceMin" label="参考价下限(元)" style={{ flex: 1, marginRight: 8 }}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="priceMax" label="上限(元)" style={{ flex: 1, marginRight: 8 }}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="unit" label="单位" style={{ width: 90 }}><Input maxLength={10} /></Form.Item>
          </Space.Compact>
          <Form.Item name="perRoom" label="布置提示"><Input placeholder="如：每个窗帘位 1 台" maxLength={60} /></Form.Item>
          <Form.Item name="imageUrl" label="产品图（即点位图标）">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Upload accept="image/jpeg,image/png,image/webp" showUploadList={false} beforeUpload={(f) => void uploadImage(f)}>
                <Button icon={<PlusOutlined />}>上传产品图（自动压缩）</Button>
              </Upload>
              <Form.Item noStyle shouldUpdate>
                {() => {
                  const u = form.getFieldValue('imageUrl');
                  return u ? <Text type="secondary" style={{ fontSize: 12 }}>已上传：{u.split('/').pop()}，重新上传可替换</Text> : <Text type="secondary" style={{ fontSize: 12 }}>不上传则点位显示品类图标</Text>;
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
            <Form.Item name="icon" label="图标" style={{ width: 130, marginRight: 8 }}>
              <Select
                options={ICON_CHOICES.map((k) => ({ value: k, label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} dangerouslySetInnerHTML={{ __html: iconSvgByKey(k, 16, '#555') }} /> }))}
                labelRender={({ value }) => <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: iconSvgByKey(String(value), 16, '#555') }} />}
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
              { title: '', width: 44, render: (_, c) => <span style={{ display: 'inline-flex', color: c.color }} dangerouslySetInnerHTML={{ __html: iconSvgByKey(c.icon, 18, c.color) }} /> },
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
