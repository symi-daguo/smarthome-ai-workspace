import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Card, Checkbox, Col, Divider, Empty, Form, Input, Modal, Popconfirm, Row, Select, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import { KeyOutlined, PlusOutlined, RobotOutlined, TeamOutlined } from '@ant-design/icons';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { pageContainerStyle } from '../theme/tokens';
import { downloadBlob } from '../lib/download';

const { Text, Paragraph } = Typography;

/**
 * 团队与机器接入（0.1.54）
 *
 * 一页装三件事，因为它们本质是同一件事的三个面：
 *   ① 人类成员：谁在用这个系统
 *   ② 角色模板：他被允许做什么
 *   ③ 机器账号与 API Key：哪台电脑上的工具在用这个系统
 *
 * 角色模板做成**可点选的卡片**而不是权限勾选框：本项目的权限 action 有 15 个，
 * 让店长逐项勾，既容易配错也没人配得下去。模板来自服务端 `GET /api/team/role-templates`，
 * 权限模型只有 prisma/seed.ts 一个事实来源，不会出现「界面配一套、后端判另一套」。
 */

interface RoleTemplate {
  key: string;
  id: string;
  name: string;
  scope: string;
  permissions: string[];
  description: string;
  /** true=预置模板；false=本租户自定义 */
  isSystem: boolean;
  permissionCount: number;
}

interface Member {
  id: string;
  phone: string;
  displayName: string;
  roleKey: string;
  roleName: string;
  permissions: string[];
  isServiceAccount: boolean;
  joinedAt: string;
}

interface ServiceAccount {
  id: string;
  name: string;
  phone: string;
  roleKey: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  revoked: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const ROLE_TONE: Record<string, string> = {
  super_admin: 'gold',
  tenant_admin: 'purple',
  sales: 'magenta',
  designer: 'blue',
  delivery: 'geekblue',
  finance: 'green',
  purchase: 'lime',
  marketing: 'pink',
  service: 'cyan',
  viewer: 'default',
};

/** 权限 action 的人话说明与分组。
 *
 * 与后端 `rbac/permissions.ts` 的 PERMISSION_CATALOG 同源同口径：
 * 读/写二元切分（Appwrite 的 resource.read / resource.write 模式），
 * 且「写隐含读」由后端 AbilityFactory 统一处理，这里不重复表达。
 * 界面上必须显示人话而不是 `quote:write` 这种串 —— 店长看不懂串，但看得懂「做报价、改产品库」。
 */
const PERMISSION_CATALOG: { action: string; label: string; group: string }[] = [
  { action: 'quote:read', label: '查看报价与产品库', group: '报价' },
  { action: 'quote:write', label: '做报价、改产品库', group: '报价' },
  { action: 'order:read', label: '查看接单与客户跟进', group: '接单' },
  { action: 'order:write', label: '建单、改状态、加跟进', group: '接单' },
  { action: 'publish:read', label: '查看朋友圈/小红书素材', group: '内容' },
  { action: 'publish:write', label: '生成并发布文案与图文', group: '内容' },
  { action: 'content:read', label: '查看素材库与产物', group: '内容' },
  { action: 'content:generate', label: '生成方案与出图、生视频', group: '内容' },
  { action: 'content:extract', label: '内容提取与解析', group: '内容' },
  { action: 'knowledge:read', label: '查阅知识库', group: '知识库' },
  { action: 'knowledge:manage', label: '维护知识库', group: '知识库' },
  { action: 'cs:read', label: '查看反馈与工单', group: '协作' },
  { action: 'cs:write', label: '提交与处理反馈', group: '协作' },
  { action: 'tenant:member:manage', label: '管理团队成员', group: '团队' },
  { action: 'tenant:role:assign', label: '分配角色', group: '团队' },
  { action: 'tenant:token:grant', label: '发放额度', group: '团队' },
  { action: 'tenant:billing:view', label: '查看账单与额度', group: '团队' },
  { action: 'platform:billing:manage', label: '模型配置与数据备份', group: '平台' },
  { action: 'platform:audit:view', label: '查看操作审计', group: '平台' },
  { action: 'platform:tenant:manage', label: '管理租户', group: '平台' },
];

/** 写权限隐含读权限：勾了「写」不必再勾「读」，界面直接体现这条规则 */
const WRITE_IMPLIES_READ: Record<string, string> = {
  'quote:write': 'quote:read',
  'order:write': 'order:read',
  'publish:write': 'publish:read',
  'content:generate': 'content:read',
  'cs:write': 'cs:read',
};

const MAX_PERMISSIONS = PERMISSION_CATALOG.length;

export function TeamPage(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [svcs, setSvcs] = useState<ServiceAccount[]>([]);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [ownPermissions, setOwnPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  // 新建成员
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [roleKey, setRoleKey] = useState('viewer');

  // 机器账号
  const [svcOpen, setSvcOpen] = useState(false);
  const [svcForm] = Form.useForm();
  const [svcSaving, setSvcSaving] = useState(false);

  // API Key：签发后明文只出现这一次
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);
  const [keyFor, setKeyFor] = useState<string | undefined>(undefined);

  // 自定义角色编辑器
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [roleForm] = Form.useForm();

  const openRoleEditor = (): void => {
    setPicked([]);
    roleForm.resetFields();
    setRoleOpen(true);
  };

  const saveRole = async (): Promise<void> => {
    const v = await roleForm.validateFields();
    if (picked.length === 0) {
      message.warning('至少勾一项权限，否则这个角色什么都做不了');
      return;
    }
    setRoleSaving(true);
    try {
      await api('/api/team/roles', {
        method: 'POST',
        body: JSON.stringify({ ...v, permissions: picked }),
      });
      message.success(`已创建角色「${v.name}」`);
      setRoleOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setRoleSaving(false);
    }
  };

  const removeSvc = async (userId: string): Promise<void> => {
    try {
      await api(`/api/team/service-accounts/${userId}`, { method: 'DELETE' });
      message.success('机器账号已删除，其 API Key 同时失效');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const removeRole = async (id: string): Promise<void> => {
    try {
      await api(`/api/team/roles/${id}`, { method: 'DELETE' });
      message.success('已删除');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, m, s, k] = await Promise.all([
        api<RoleTemplate[]>('/api/team/role-templates'),
        api<Member[]>('/api/team/members'),
        api<ServiceAccount[]>('/api/team/service-accounts'),
        api<ApiKeyRow[]>('/api/agent/keys'),
      ]);
      setTemplates(t); setMembers(m); setSvcs(s); setKeys(k);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);

  // 权限勾选器只允许勾「我自己也有的」——提前在界面上挡住，别让用户提交了才吃 403
  useEffect(() => {
    api<{ memberships: { tenantId: string; permissions: string[] }[] }>('/api/auth/me')
      .then((me) => setOwnPermissions(me.memberships[0]?.permissions ?? []))
      .catch(() => undefined);
  }, []);

  const createMember = async (): Promise<void> => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api('/api/team/members', { method: 'POST', body: JSON.stringify(v) });
      message.success(`已创建成员 ${v.displayName}，把初始密码线下告知本人即可`);
      setOpen(false);
      form.resetFields();
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const changeRole = async (userId: string, next: string): Promise<void> => {
    try {
      await api(`/api/team/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ roleKey: next }) });
      message.success('已更新角色');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败');
      await load();
    }
  };

  const removeMember = async (userId: string): Promise<void> => {
    try {
      await api(`/api/team/members/${userId}`, { method: 'DELETE' });
      message.success('已移出团队，其 API Key 同时失效');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '移除失败');
    }
  };

  const createSvc = async (): Promise<void> => {
    const v = await svcForm.validateFields();
    setSvcSaving(true);
    try {
      await api('/api/agent/service-accounts', { method: 'POST', body: JSON.stringify(v) });
      message.success('机器账号已创建');
      setSvcOpen(false);
      svcForm.resetFields();
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSvcSaving(false);
    }
  };

  const issueKey = async (serviceAccountId: string): Promise<void> => {
    try {
      const r = await api<{ token: string; name: string }>('/api/agent/keys', {
        method: 'POST',
        body: JSON.stringify({ name: `Key-${new Date().toISOString().slice(0, 10)}`, ttlDays: 90, serviceAccountId }),
      });
      setIssued(r);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '签发失败');
    }
  };

  const revokeKey = async (id: string): Promise<void> => {
    try {
      await api(`/api/agent/keys/${id}/revoke`, { method: 'POST' });
      message.success('已吊销，该 Key 立即失效');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '吊销失败');
    }
  };

  const copyKey = (text: string): void => {
    void navigator.clipboard?.writeText(text);
    message.success('已复制');
  };

  const exportKeys = (): void => {
    downloadBlob(
      new Blob([`﻿${['名称,前缀,状态,最近使用,过期时间', ...keys.map((k) => [
        k.name, k.prefix, k.revoked ? '已吊销' : '有效',
        k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('zh-CN') : '从未使用',
        k.expiresAt ? new Date(k.expiresAt).toLocaleString('zh-CN') : '—',
      ].join(','))].join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }),
      'API-Key-清单.csv',
    );
    message.success('已导出 Key 清单');
  };

  const human = members.filter((m) => !m.isServiceAccount);

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="团队与机器接入"
        description="给同事开账号、定权限；给这台电脑上的工具开 API Key。不需要看懂权限串，选角色模板即可。"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建成员</Button>}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="局域网使用：主账号在这台电脑上操作，团队成员用浏览器打开「主机 IP:5173」即可访问同一套数据；不会用的功能可以直接问 Agent。"
      />

      {/* ---------- 角色模板：给管理员点选，不给逐项勾权限 ---------- */}
      <Card
        title={<Space size={8}><TeamOutlined />角色模板</Space>}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openRoleEditor()}>自定义角色</Button>}
        style={{ marginBottom: 16 }}
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          选角色就是定权限。下面 {templates.filter((t) => t.isSystem).length} 个是按智能家居门店岗位预置的模板，
          直接点就能用；模板不够用就点右上角「自定义角色」，自己勾权限组合成新岗位 ——
          权限共 {MAX_PERMISSIONS} 项，按业务分组列出来，不用看懂 <Text code>platform:xxx</Text> 这种串。
        </Paragraph>
        <Row gutter={[12, 12]}>
          {templates.map((t) => (
            <Col key={t.id} xs={24} sm={12} lg={8} xxl={6}>
              <Card
                size="small"
                hoverable
                onClick={() => { setRoleKey(t.key); setOpen(true); form.setFieldsValue({ roleKey: t.key }); }}
                style={{
                  height: '100%',
                  borderColor: roleKey === t.key ? token.colorPrimary : undefined,
                  background: roleKey === t.key ? token.colorPrimaryBg : undefined,
                }}
              >
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space size={6} wrap>
                    <Text strong>{t.name}</Text>
                    {!t.isSystem && <Tag color="processing">自定义</Tag>}
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t.description || '（未填写说明）'}</Text>
                  <Space size={4} wrap>
                    {t.permissions.slice(0, 3).map((p) => (
                      <Tag key={p} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                        {PERMISSION_CATALOG.find((c) => c.action === p)?.label ?? p}
                      </Tag>
                    ))}
                    {t.permissions.length > 3 && (
                      <Tooltip title={t.permissions.join('、')}>
                        <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>+{t.permissions.length - 3}</Tag>
                      </Tooltip>
                    )}
                  </Space>
                  {!t.isSystem && (
                    <Popconfirm title="删除这个自定义角色？" onConfirm={(e) => { e?.stopPropagation(); void removeRole(t.id); }}>
                      <Button size="small" danger block onClick={(e) => e.stopPropagation()}>删除角色</Button>
                    </Popconfirm>
                  )}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      {/* ---------- 人类成员 ---------- */}
      <Card title={`团队成员（${human.length}）`} loading={loading} style={{ marginBottom: 16 }}>
        <Table<Member>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={human}
          locale={{ emptyText: <Empty description="还没有成员，点右上角「新建成员」" /> }}
          columns={[
            {
              title: '成员',
              render: (_, m) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{m.displayName}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{m.phone}</Text>
                </Space>
              ),
            },
            {
              title: '角色',
              dataIndex: 'roleKey',
              width: 210,
              render: (v: string, m) => (
                <Select
                  size="small"
                  value={v}
                  style={{ width: 180 }}
                  onChange={(next) => void changeRole(m.id, next)}
                  options={templates.map((t) => ({ value: t.key, label: t.name }))}
                />
              ),
            },
            {
              title: '权限',
              dataIndex: 'permissions',
              width: 110,
              render: (v: string[]) => <Tooltip title={v.join('、')}><Tag>{v.length} 项</Tag></Tooltip>,
            },
            {
              title: '加入时间',
              dataIndex: 'joinedAt',
              width: 160,
              render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleDateString('zh-CN')}</Text>,
            },
            {
              title: '操作',
              width: 90,
              render: (_, m) => (
                <Popconfirm title={`把 ${m.displayName} 移出团队？`} description="其 API Key 会同时失效" onConfirm={() => void removeMember(m.id)}>
                  <Button size="small" danger>移出</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      {/* ---------- 机器账号 ---------- */}
      <Card
        title={<Space size={8}><RobotOutlined />机器账号（{svcs.length}）</Space>}
        extra={<Space><Button icon={<KeyOutlined />} onClick={exportKeys}>导出 Key 清单</Button><Button icon={<PlusOutlined />} onClick={() => setSvcOpen(true)}>新建机器账号</Button></Space>}
        loading={loading}
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          机器账号没有可用密码，只能用 API Key 访问。Key 就是这台电脑上的 AI 工具、脚本或另一台终端的通行证 ——
          给它们用，别给人用（人的账号请用上面的「新建成员」）。
        </Paragraph>
        {svcs.length === 0 ? (
          <Empty description="还没有机器账号" />
        ) : (
          <Table<ServiceAccount>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={svcs}
            columns={[
              { title: '名称', dataIndex: 'name', render: (v: string) => <Text strong>{v}</Text> },
              { title: '账号', dataIndex: 'phone', render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> },
              { title: '角色', dataIndex: 'roleKey', width: 130, render: (v: string) => <Tag color={ROLE_TONE[v] ?? 'default'}>{templates.find((t) => t.key === v)?.name ?? v}</Tag> },
              {
                title: '操作',
                width: 190,
                render: (_, s) => (
                  <Space size={6}>
                    <Button size="small" type="primary" icon={<KeyOutlined />} onClick={() => setKeyFor(s.id)}>签发 Key</Button>
                    <Popconfirm
                      title={`删除机器账号「${s.name}」？`}
                      description="其全部 API Key 会同时吊销，立即失效"
                      onConfirm={() => void removeSvc(s.id)}
                    >
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}

        {keys.length > 0 && (
          <>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '16px 0 8px' }}>已签发的 Key</Text>
            <Table<ApiKeyRow>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={keys}
              columns={[
                { title: '名称', dataIndex: 'name' },
                { title: '前缀', dataIndex: 'prefix', render: (v: string) => <Text code>{v}</Text> },
                {
                  title: '状态',
                  width: 90,
                  render: (_, k) => (k.revoked ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag>),
                },
                {
                  title: '最近使用',
                  dataIndex: 'lastUsedAt',
                  width: 170,
                  render: (v: string | null) => <Text type="secondary" style={{ fontSize: 12 }}>{v ? new Date(v).toLocaleString('zh-CN') : '从未使用'}</Text>,
                },
                {
                  title: '过期',
                  dataIndex: 'expiresAt',
                  width: 110,
                  render: (v: string | null) => <Text type="secondary" style={{ fontSize: 12 }}>{v ? new Date(v).toLocaleDateString('zh-CN') : '—'}</Text>,
                },
                {
                  title: '操作',
                  width: 90,
                  render: (_, k) => (k.revoked ? null : (
                    <Popconfirm title="吊销后立即失效，无法恢复" onConfirm={() => void revokeKey(k.id)}>
                      <Button size="small" danger>吊销</Button>
                    </Popconfirm>
                  )),
                },
              ]}
            />
          </>
        )}
      </Card>

      {/* ---------- 自定义角色：按业务分组勾权限 ---------- */}
      <Modal
        open={roleOpen}
        title="自定义角色"
        onCancel={() => setRoleOpen(false)}
        onOk={() => void saveRole()}
        okText="创建角色"
        confirmLoading={roleSaving}
        width={720}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12, fontSize: 12 }}
          message="只能勾你自己也拥有的权限 —— 你能给出去的，永远不会比你手上的多。这样任何人都无法靠建角色来提权。"
        />
        <Form form={roleForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请填角色名' }, { max: 30, message: '最多 30 字' }]}>
                <Input placeholder="例如：门店店长助理" maxLength={30} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="description" label="这个岗位干什么">
                <Input placeholder="例如：协助店长处理报价与跟单" maxLength={120} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        <Divider style={{ margin: '4px 0 12px' }}>勾选权限（已选 {picked.length} 项）</Divider>
        {Object.entries(
          PERMISSION_CATALOG.reduce<Record<string, typeof PERMISSION_CATALOG>>((acc, c) => {
            (acc[c.group] ??= []).push(c);
            return acc;
          }, {}),
        ).map(([group, items]) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>{group}</Text>
            <Space size={[12, 4]} wrap style={{ marginTop: 4 }}>
              {items.map((c) => {
                const allowed = ownPermissions.includes(c.action);
                return (
                  <Tooltip key={c.action} title={allowed ? c.action : `${c.action}（你没有这项权限，不能授予别人）`}>
                    <Checkbox
                      checked={picked.includes(c.action)}
                      disabled={!allowed}
                      onChange={(e) => {
                        if (e.target.checked) {
                          // 勾「写」自动带上它隐含的「读」，与后端 AbilityFactory 的规则一致
                          const implied = WRITE_IMPLIES_READ[c.action];
                          setPicked((prev) => (implied && !prev.includes(implied) ? [...prev, c.action, implied] : [...prev, c.action]));
                        } else {
                          setPicked((prev) => {
                            const next = prev.filter((x) => x !== c.action);
                            // 取消「写」时，只有在没有别的写权限依赖它的情况下才一并取消「读」
                            const implied = WRITE_IMPLIES_READ[c.action];
                            const stillNeeded = implied
                              ? Object.entries(WRITE_IMPLIES_READ).some(([w, r]) => r === implied && next.includes(w))
                              : false;
                            return implied && !stillNeeded ? next.filter((x) => x !== implied) : next;
                          });
                        }
                      }}
                    >
                      {c.label}
                    </Checkbox>
                  </Tooltip>
                );
              })}
            </Space>
          </div>
        ))}
        {ownPermissions.length === 0 && (
          <Alert type="warning" showIcon message="未能取到你当前的权限列表，勾选框可能全部不可用，请刷新页面重试。" />
        )}
      </Modal>

      {/* ---------- 新建成员 ---------- */}
      <Modal
        open={open}
        title="新建团队成员"
        onCancel={() => setOpen(false)}
        onOk={() => void createMember()}
        okText="创建"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12, fontSize: 12 }}
          message="初始密码请线下告知本人，并提醒其登录后在「个人中心」自行修改。"
        />
        <Form form={form} layout="vertical" initialValues={{ roleKey }}>
          <Form.Item name="displayName" label="姓名" rules={[{ required: true, message: '请填姓名' }]}>
            <Input placeholder="例如：李店长" maxLength={40} />
          </Form.Item>
          <Form.Item name="phone" label="登录手机号" rules={[{ required: true, message: '请填手机号' }, { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不对' }]}>
            <Input placeholder="11 位手机号" maxLength={11} />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, message: '请设初始密码' }, { min: 8, message: '至少 8 位' }, { pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, message: '需同时含字母和数字' }]}>
            <Input.Password placeholder="至少 8 位，含字母和数字" maxLength={72} />
          </Form.Item>
          <Form.Item label="角色模板" extra={templates.find((t) => t.key === (form.getFieldValue('roleKey') ?? roleKey))?.description}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {templates.map((t) => (
                <Button
                  key={t.key}
                  size="small"
                  type={roleKey === t.key ? 'primary' : 'default'}
                  onClick={() => { setRoleKey(t.key); form.setFieldsValue({ roleKey: t.key }); }}
                >
                  {t.name}
                </Button>
              ))}
            </div>
            <Form.Item name="roleKey" hidden><Input /></Form.Item>
          </Form.Item>
        </Form>
      </Modal>

      {/* ---------- 新建机器账号 ---------- */}
      <Modal
        open={svcOpen}
        title="新建机器账号"
        onCancel={() => setSvcOpen(false)}
        onOk={() => void createSvc()}
        okText="创建"
        confirmLoading={svcSaving}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12, fontSize: 12 }}
          message="机器账号没有可用密码，只能用 API Key 访问。角色决定它能做什么 —— 只需要读数据就用「只读成员」。"
        />
        <Form form={svcForm} layout="vertical" initialValues={{ roleKey: 'viewer' }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填名称' }]}>
            <Input placeholder="例如：MacBook 上的编程助手" maxLength={60} />
          </Form.Item>
          <Form.Item name="roleKey" label="角色模板">
            <Select
              options={templates.map((t) => ({ value: t.key, label: `${t.name}${t.isSystem ? '' : '（自定义）'}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* ---------- 签发 Key：明文只在这里出现一次 ---------- */}
      <Modal
        open={Boolean(keyFor)}
        title="为这个机器账号签发 API Key"
        onCancel={() => setKeyFor(undefined)}
        onOk={() => { if (keyFor) void issueKey(keyFor); setKeyFor(undefined); }}
        okText="签发"
        cancelText="取消"
        destroyOnHidden
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          签发后请立刻保存 —— 平台只保留可吊销的记录，不保存密钥材料，关掉这个弹窗就再也看不到了。
        </Paragraph>
      </Modal>

      <Modal
        open={Boolean(issued)}
        title="Key 已签发"
        onCancel={() => setIssued(null)}
        footer={<Button type="primary" onClick={() => setIssued(null)}>我已保存</Button>}
      >
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="这是唯一一次显示完整 Key，关闭后无法再次查看。" />
        <Paragraph style={{ marginBottom: 8 }}>
          把它填进那台电脑上的工具配置，接口基址填主机地址，例如 <Text code>http://&lt;主机IP&gt;:5173</Text>，
          请求头 <Text code>Authorization: Bearer &lt;Key&gt;</Text>。
          想让它先摸清能做什么，就让它读 <Text code>/api/agent/manifest</Text>。
        </Paragraph>
        <Input.TextArea value={issued?.token ?? ''} readOnly autoSize={{ minRows: 3, maxRows: 6 }} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        <Button style={{ marginTop: 8 }} onClick={() => copyKey(issued?.token ?? '')}>复制 Key</Button>
      </Modal>
    </div>
  );
}
