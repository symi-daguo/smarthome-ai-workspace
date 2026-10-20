import { App as AntApp, Avatar, Tooltip, Upload } from 'antd';
import { CameraOutlined } from '@ant-design/icons';
import { useState, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { compressImage } from '../lib/compress';
import { useAuth } from '../store/AuthContext';

/**
 * 用户头像（0.1.58）
 *
 * 有图显示图，没图回退到「头像底色 + 姓名首字」——所以头像色不是被替换掉，而是降级路径。
 *
 * 刻意**不新建上传端点、不引组件库**：复用既有的 `POST /api/media/uploads`（multipart）、
 * `lib/compress.ts` 的 compressImage（上传前压缩，省流量也省磁盘 —— 磁盘被挤爆的隐患里，
 * 头像这种小图是最不该随手丢大图的入口）、以及 AuthContext 已有的 `refresh()`。
 */

export function UserAvatar({
  user,
  size,
  shape = 'circle',
  fontSize,
  onClick,
  cursor,
  allowUpload = false,
}: {
  user: { displayName?: string; avatarColor?: string | null; avatarUrl?: string } | null | undefined;
  size: number;
  shape?: 'circle' | 'square';
  fontSize?: number;
  onClick?: () => void;
  cursor?: string;
  /** 只有个人中心那一个大头像给上传入口；侧栏/顶栏点击直接跳个人中心，不重复放上传按钮 */
  allowUpload?: boolean;
}): ReactNode {
  const { message } = AntApp.useApp();
  const { refresh } = useAuth();
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      const blob = await compressImage(file);
      const fd = new FormData();
      fd.append('file', blob, file.name);
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      await api('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ avatarUrl: res.url }) });
      await refresh();
      message.success('头像已更新');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '头像上传失败');
    } finally {
      setUploading(false);
    }
  };

  const inner: ReactNode = (
    <Avatar
      size={size}
      shape={shape}
      src={user?.avatarUrl ? fileUrl(user.avatarUrl) : undefined}
      style={{ background: user?.avatarColor ?? undefined, fontSize, fontWeight: 700, flex: 'none', cursor, objectFit: 'cover' }}
      onClick={onClick}
    >
      {(user?.displayName ?? 'U').slice(0, 1)}
    </Avatar>
  );

  if (!allowUpload) return inner;

  return (
    <Upload
      accept="image/png,image/jpeg,image/webp"
      showUploadList={false}
      disabled={uploading}
      beforeUpload={(f) => {
        void upload(f);
        return false;
      }}
    >
      <Tooltip title={uploading ? '上传中…' : '上传头像'}>
        <span style={{ display: 'inline-flex', position: 'relative' }}>
          {inner}
          <CameraOutlined
            style={{
              position: 'absolute', right: -2, bottom: -2, fontSize: 12,
              background: 'rgba(0,0,0,.55)', color: '#fff', padding: 3, borderRadius: '50%',
            }}
          />
        </span>
      </Tooltip>
    </Upload>
  );
}
