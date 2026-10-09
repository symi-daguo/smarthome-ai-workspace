import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RobotOutlined, ShopOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fileUrl } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { CATEGORY_META } from '../lib/pointOverlay';
import { categoryIconSvg } from '../lib/product-icons';
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

const CATEGORY_OPTIONS = Object.entries(CATEGORY_META).map(([value, m]) => ({ value, label: m.label }));

/**
 * 产品中心（对齐参考站"公共库与我的库"）：
 * 公共库=平台种子，可复制到我的库；我的库=本租户 CRUD（含产品图上传）。
 * 联动规则：点位编辑器与智能报价的产品来源 = 公共库 + 我的库；
 * 产品图即点位图标（编辑器优先用产品照片，无图回退品类 SVG）。
 */
export function ProductCenter(): ReactNode {
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'public' | 'mine'>('public');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string | undefined>();
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [form] = Form.useForm<ProductForm>();

  const reload = useCallback(async (): Promise<void> => {
    setRows(await api<ProductRow[]>('/api/products'));
  }, []);

  useEffect(() => {
    reload().catch((e) => message.error((e as Error).message)).finally(() => setLoading(false));
  }, [reload, message]);

  const data = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === 'public' ? r.tenantId !== null : r.tenantId === null) return false;
      if (catFilter && r.category !== catFilter) return false;
      if (kw && !`${r.name}${r.brand}${r.model}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [rows, tab, search, catFilter]);

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

  /** 任意行（含公共库）快速更换产品图：只 PATCH imageUrl，产品图即点位图标 */
  const quickUploadImage = async (row: ProductRow, file: File): Promise<boolean> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP');
      return false;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', `产品图-${row.name}`.slice(0, 40));
    try {
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      await api(`/api/products/${row.id}`, { method: 'PATCH', body: JSON.stringify({ imageUrl: res.url }) });
      message.success(`「${row.name}」产品图已更新`);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
    return false;
  };

  /** agent 批量处理：勾选行一次补全文案 + 批量生成产品图（生图按张扣额度） */
  const aiProcess = (): void => {
    if (!selectedIds.length) {
      message.warning('请先勾选要处理的产品');
      return;
    }
    modal.confirm({
      title: `AI 批量处理 ${selectedIds.length} 个产品？`,
      content: '智能体将补全缺失的品牌/型号/布置提示，并按产品名+品类生成白底产品主图（产品图即点位图标）。生图按张扣减额度，单个失败不影响其余。',
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
          message.success(`处理完成：文案补全 ${r.copyOk} 项、产品图生成 ${r.imageOk} 项${failNote}`);
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
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP');
      return false;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', file.name.replace(/\.[^.]+$/, '').slice(0, 40));
    try {
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      form.setFieldValue('imageUrl', res.url);
      message.success('产品图已上传');
    } catch (e) {
      message.error((e as Error).message);
    }
    return false;
  };

  const thumb = (r: ProductRow): ReactNode =>
    r.imageUrl ? (
      <Image src={fileUrl(r.imageUrl)} width={40} height={40} style={{ borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(0,0,0,.06)' }} />
    ) : (
      <span style={{ width: 40, height: 40, borderRadius: 8, background: `${CATEGORY_META[r.category]?.color ?? '#888'}1a`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: categoryIconSvg(r.category, 20, CATEGORY_META[r.category]?.color ?? '#888') }} />
    );

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="产品中心"
        description="公共库与我的库：上传或复制产品、维护产品图（产品图即点位图标），联动智能报价与设备/灯光点位选品"
        extra={
          <Space wrap>
            <Button onClick={() => navigate('/quote')}>智能报价</Button>
            <Button onClick={() => navigate('/device-layout')}>设备点位</Button>
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
          <Input.Search placeholder="搜索名称 / 品牌 / 型号" allowClear style={{ width: 240 }} onChange={(e) => setSearch(e.target.value)} />
          <Select placeholder="全部分类" allowClear style={{ width: 140 }} value={catFilter} onChange={setCatFilter} options={CATEGORY_OPTIONS} />
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
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === 'mine' ? '我的库暂无产品：从公共库「复制到我的库」或点右上角新增' : '无匹配产品'} /> }}
          columns={[
            { title: '', dataIndex: 'imageUrl', width: 56, render: (_, r) => thumb(r) },
            { title: '产品名称', dataIndex: 'name', render: (v: string, r) => (
              <Space size={6}>
                <Text strong>{v}</Text>
                {r.tenantId ? <Tag color="green">我的</Tag> : null}
              </Space>
            ) },
            { title: '分类', dataIndex: 'category', width: 110, render: (v: string) => <Tag color={CATEGORY_META[v]?.color}>{CATEGORY_META[v]?.label ?? v}</Tag> },
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
          <ShopOutlined /> 联动规则：设备/灯光点位与智能报价的选品来源 = 公共库 + 我的库；每个产品都可上传自己的 PNG/JPG 主图（产品图即点位图标，无图回退品类图标）；勾选产品后「AI 批量处理」由智能体补全文案并批量生成产品主图。
        </Text>
      </Card>

      <Modal title={editing ? `编辑「${editing.name}」` : '新增我的产品'} open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => void saveProduct()} okText="保存" confirmLoading={saving} destroyOnHidden width={520}>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Space.Compact block>
            <Form.Item name="name" label="产品名称" rules={[{ required: true, message: '必填' }, { max: 60 }]} style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="如：智能中控屏 Pro" />
            </Form.Item>
            <Form.Item name="category" label="分类" rules={[{ required: true }]} style={{ width: 140 }}>
              <Select options={CATEGORY_OPTIONS} />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="brand" label="品牌" style={{ flex: 1, marginRight: 8 }}><Input maxLength={40} /></Form.Item>
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
                <Button icon={<PlusOutlined />}>上传产品图</Button>
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
    </div>
  );
}
