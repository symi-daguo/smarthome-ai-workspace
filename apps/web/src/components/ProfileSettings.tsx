import { DownloadOutlined } from '@ant-design/icons';
import { App as AntApp, Avatar, Button, ColorPicker, Divider, Form, Input, Modal, Radio, Space, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from '../lib/api';
import { useAuth, type UserProfile } from '../store/AuthContext';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';

const { Text } = Typography;

interface ProfileForm {
  displayName: string;
  // ColorPicker 受控值为 string 或 Color 对象（toHexString）
  avatarColor: string | { toHexString?: () => string };
}

interface StorageStat {
  usedBytes: number;
  quotaBytes: number;
  assets: number;
  oldest: string | null;
}

/**
 * 个人设置弹窗：昵称 / 头像颜色 / 主题模式 / 修改密码 / 数据备份（管理员）。
 * 自部署单机场景所有数据都归部署者，备份导出全库 JSON 供升级迁移留底。
 */
export function ProfileSettings({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const { message, modal } = AntApp.useApp();
  const { user, refresh } = useAuth();
  const { mode, setMode } = useTheme();
  const [form] = Form.useForm<ProfileForm>();
  const [saving, setSaving] = useState(false);
  const [pwdSaving, setPwdSaving] = useState(false);
  const [backing, setBacking] = useState(false);
  const [storage, setStorage] = useState<StorageStat | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const isAdmin = user?.memberships.some((m) => m.permissions.includes('platform:billing:manage')) ?? false;

  // 打开弹窗时自动拉取产物占用（管理员）
  useEffect(() => {
    if (open && isAdmin) void loadStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdmin]);

  const loadStorage = async (): Promise<void> => {
    try {
      setStorage(await api<StorageStat>('/api/admin/storage'));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const cleanup = (): void => {
    modal.confirm({
      title: '清理 30 天前的产物？',
      content: '删除 30 天前生成且未被方案/点位布局引用的图片与视频（含本地文件），用于释放磁盘空间。此操作不可恢复。',
      okText: '确认清理',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setCleaning(true);
        try {
          const r = await api<{ deleted: number; freedBytes: number }>('/api/admin/storage/cleanup?beforeDays=30', { method: 'POST' });
          message.success(`已清理 ${r.deleted} 项，释放 ${(r.freedBytes / 1048576).toFixed(1)} MB`);
          await loadStorage();
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setCleaning(false);
        }
      },
    });
  };

  const saveProfile = async (): Promise<void> => {
    let values: ProfileForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const color = typeof values.avatarColor === 'string' ? values.avatarColor : values.avatarColor?.toHexString?.() ?? '#6D4DF6';
      await api<UserProfile>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: values.displayName.trim(),
          avatarColor: color,
        }),
      });
      await refresh();
      message.success('个人资料已保存');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changePwd = async (oldPassword: string, newPassword: string): Promise<void> => {
    setPwdSaving(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
      message.success('密码已修改，下次登录生效');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPwdSaving(false);
    }
  };

  const downloadBackup = async (): Promise<void> => {
    setBacking(true);
    try {
      const res = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } });
      if (!res.ok) throw new Error(`备份失败 ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('全库 JSON 已导出（产物文件在 uploads 卷，迁移时一并备份）');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBacking(false);
    }
  };

  return (
    <Modal title="个人设置" open={open} onCancel={onClose} footer={null} destroyOnHidden width={460}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ displayName: user?.displayName ?? '', avatarColor: user?.avatarColor ?? '#6D4DF6' }}
        style={{ marginTop: 8 }}
      >
        <Space align="start" size={16} style={{ width: '100%' }}>
          <Form.Item noStyle shouldUpdate>
            {() => (
              <Avatar
                size={56}
                style={{
                  background: (() => {
                    const v = form.getFieldValue('avatarColor');
                    return typeof v === 'string' ? v : (v?.toHexString?.() ?? '#6D4DF6');
                  })(),
                  flex: 'none',
                }}
              >
                {(form.getFieldValue('displayName') ?? user?.displayName ?? 'U').slice(0, 1)}
              </Avatar>
            )}
          </Form.Item>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Form.Item name="displayName" label="昵称" rules={[{ required: true, message: '请输入昵称' }, { max: 32 }]}>
              <Input placeholder="显示名称" />
            </Form.Item>
            <Form.Item name="avatarColor" label="头像颜色">
              <ColorPicker showText format="hex" disabledAlpha />
            </Form.Item>
          </div>
        </Space>
        <Button type="primary" loading={saving} onClick={() => void saveProfile()} block>
          保存资料
        </Button>
      </Form>

      <Divider style={{ margin: '16px 0' }} />

      <Text type="secondary" style={{ fontSize: 12 }}>界面主题</Text>
      <Radio.Group
        style={{ display: 'block', marginTop: 8 }}
        optionType="button"
        buttonStyle="solid"
        value={mode}
        onChange={(e) => setMode(e.target.value as ThemeMode)}
        options={THEME_OPTIONS}
        block
      />

      <Divider style={{ margin: '16px 0' }} />

      <Form layout="vertical" onFinish={(v: { oldPassword: string; newPassword: string }) => void changePwd(v.oldPassword, v.newPassword)}>
        <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, max: 64, message: '至少 8 位' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button htmlType="submit" loading={pwdSaving} block>
          修改密码
        </Button>
      </Form>

      {isAdmin ? (
        <>
          <Divider style={{ margin: '16px 0' }} />
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Button icon={<DownloadOutlined />} loading={backing} onClick={() => void downloadBackup()} block>
              导出全库数据备份（JSON）
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              升级迁移前留底；产物文件位于 uploads 卷（docker volume），迁移时连同数据库卷一起备份即可完整恢复。
            </Text>
            <Space.Compact block>
              <Button style={{ flex: 1 }} onClick={() => void loadStorage()}>
                {storage ? `产物占用 ${(storage.usedBytes / 1048576).toFixed(1)} / ${(storage.quotaBytes / 1048576).toFixed(0)} MB` : '查看产物存储占用'}
              </Button>
              <Button danger loading={cleaning} disabled={!storage} onClick={() => void cleanup()}>
                清理 30 天前未引用产物
              </Button>
            </Space.Compact>
          </Space>
        </>
      ) : null}
    </Modal>
  );
}

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'auto' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];
