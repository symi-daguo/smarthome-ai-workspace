import {
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { App as AntApp, Button, Grid, Modal, Select, Typography, Upload, theme } from 'antd';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { INK_BLACK, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

const SCENES = ['观影模式', '会客模式', '就餐模式', '起夜模式', '灯光调节'];

const SCENE_HINTS: Record<string, string> = {
  观影模式: '固定机位，窗帘缓缓关闭，电视打开，灯光逐渐变暗，持续到片尾。',
  会客模式: '镜头缓推，客厅主灯与灯带渐亮至会客亮度，氛围温暖明亮。',
  就餐模式: '餐桌上方吊灯渐亮，餐边灯带同步亮起，色调暖白。',
  起夜模式: '夜晚走廊与床底感应灯带以 10% 低亮度缓缓亮起，不刺眼。',
  灯光调节: '同一空间内灯光从冷白渐变到暖黄，展示色温调节效果。',
};

const DURATIONS = [
  { value: '5', label: '5 秒' },
  { value: '10', label: '10 秒' },
];

const RESOLUTIONS = [
  { value: '480', label: '480p 快速' },
  { value: '720', label: '720p 标准' },
  { value: '1080', label: '1080p 高清' },
];

const RATIOS = [
  { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '1:1', label: '方形 1:1' },
];

interface FirstFrame {
  assetId: string;
  url: string;
}

interface ImageAsset {
  id: string;
  title: string;
}

export function VideoStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;
  const [scene, setScene] = useState<string | null>(null);
  const [desc, setDesc] = useState('');
  const [duration, setDuration] = useState('10');
  const [res, setRes] = useState('720');
  const [ratio, setRatio] = useState('16:9');
  const [firstFrame, setFirstFrame] = useState<FirstFrame | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const pickScene = (s: string): void => {
    setScene(s);
    setDesc(SCENE_HINTS[s] ?? '');
  };

  /** 首帧上传：走 /api/media/uploads 落盘（同一点位图管线），返回 assetId+url */
  const onUpload = async (file: File): Promise<boolean> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('首帧仅支持 JPG / PNG / WebP 图片');
      return false;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', `视频首帧-${file.name.replace(/\.[^.]+$/, '').slice(0, 40)}`);
      const res2 = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      setFirstFrame({ assetId: res2.id, url: fileUrl(res2.url) });
      message.success('首帧图已就绪');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading(false);
    }
    return false;
  };

  const openPicker = async (): Promise<void> => {
    try {
      const list = await api<{ id: string; kind: string; title: string }[]>('/api/media/assets');
      setAssets(list.filter((a) => a.kind === 'image').map((a) => ({ id: a.id, title: a.title })));
      setPickerOpen(true);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const generate = async (): Promise<void> => {
    if (!desc.trim()) {
      message.warning('请先选择场景或填写视频描述');
      return;
    }
    setGenerating(true);
    try {
      const r = await api<{ url: string }>('/api/media/videos', {
        method: 'POST',
        body: JSON.stringify({
          prompt: desc.trim(),
          duration: Number(duration),
          resolution: `${res}P`,
          ratio,
          ...(firstFrame ? { firstFrameAssetId: firstFrame.assetId } : {}),
        }),
      });
      setVideoUrl(fileUrl(`${r.url}?t=${Date.now()}`));
      message.success(firstFrame ? '视频已生成（图生视频）并保存到「我的资料」' : '视频已生成并保存到「我的资料」');
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const labelStyle: CSSProperties = { fontSize: 13, color: token.colorTextSecondary, marginBottom: 6, display: 'block' };

  return (
    <div style={pageContainerStyle}>
      <Title level={3} style={{ marginBottom: 4 }}>AI 视频生成</Title>
      <Text type="secondary">上传首帧图做图生视频，或直接文字描述生成 5 秒 / 10 秒动态视频</Text>

      <div style={{ display: 'flex', gap: 20, marginTop: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 46%', minWidth: 320 }}>
          {/* ① 首帧 */}
          <div
            style={{
              background: token.colorBgContainer,
              border: `1.5px solid ${token.colorPrimary}`,
              borderRadius: 14,
              padding: '16px 18px',
              marginBottom: 12,
            }}
          >
            <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 10 }}>
              ① 首帧图（可选）：上传或用「我的资料」里的效果图，作为视频第一帧
            </Text>
            {firstFrame ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <img
                  src={firstFrame.url}
                  alt="首帧预览"
                  style={{ width: 96, height: 64, objectFit: 'cover', borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }}
                />
                <Text type="secondary" style={{ fontSize: 13, flex: 1 }}>已选择首帧，生成时自动切换图生视频模式</Text>
                <Button size="small" onClick={() => setFirstFrame(null)}>移除</Button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <Upload accept="image/*" maxCount={1} showUploadList={false} beforeUpload={onUpload}>
                  <Button icon={<PlusOutlined />} loading={uploading}>选择文件</Button>
                </Upload>
                <Button type="link" size="small" onClick={() => void openPicker()}>从「我的资料」选择</Button>
                <Text type="secondary" style={{ fontSize: 12 }}>不选首帧则按文字描述直接生成</Text>
              </div>
            )}
          </div>

          {/* ② 预设场景 */}
          <div style={{ marginBottom: 14 }}>
            <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 10 }}>② 预设智能场景</Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
              {SCENES.map((s) => {
                const active = scene === s;
                return (
                  <span
                    key={s}
                    role="button"
                    tabIndex={0}
                    onClick={() => pickScene(s)}
                    onKeyDown={(e) => e.key === 'Enter' && pickScene(s)}
                    style={{
                      padding: '7px 16px',
                      borderRadius: 9999,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      background: active ? token.colorPrimaryBg : token.colorFillQuaternary,
                      color: active ? token.colorPrimary : token.colorTextSecondary,
                      border: `1px solid ${active ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                    }}
                  >
                    {s}
                  </span>
                );
              })}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              点击场景自动填入专属描述，可继续编辑
            </Text>
          </div>

          {/* 描述 */}
          <div style={{ marginBottom: 14 }}>
            <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 8 }}>视频描述（可编辑）</Text>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="固定机位，窗帘缓缓关闭，电视打开，灯光逐渐变暗，持续到片尾。"
              style={{
                width: '100%',
                minHeight: 88,
                padding: '12px 14px',
                borderRadius: 12,
                border: `1px solid ${token.colorBorder}`,
                background: token.colorBgContainer,
                color: token.colorText,
                fontSize: 14,
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              请写清楚画面动作、灯光变化和镜头方式
            </Text>
          </div>

          {/* 参数 3 列 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
            <div>
              <span style={labelStyle}>时长</span>
              <Select value={duration} onChange={setDuration} options={DURATIONS} style={{ width: '100%' }} />
            </div>
            <div>
              <span style={labelStyle}>画质</span>
              <Select value={res} onChange={setRes} options={RESOLUTIONS} style={{ width: '100%' }} />
            </div>
            <div>
              <span style={labelStyle}>比例</span>
              <Select value={ratio} onChange={setRatio} options={RATIOS} style={{ width: '100%' }} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Button
              size="large"
              loading={generating}
              onClick={generate}
              icon={<ThunderboltFilled />}
              style={{
                height: 50,
                paddingInline: 28,
                borderRadius: 9999,
                background: INK_BLACK,
                color: '#fff',
                border: 'none',
                fontWeight: 700,
                boxShadow: 'none',
              }}
            >
              生成视频
            </Button>
            <Text type="secondary" style={{ fontSize: 13 }}>
              按额度扣费（单价由部署者配置），生成约需 1-3 分钟
            </Text>
          </div>
        </div>

        {/* 右：预览 */}
        <div
          style={{
            width: isWide ? undefined : 320,
            flex: isWide ? '1 1 54%' : 'none',
            minWidth: isWide ? 360 : undefined,
            minHeight: 380,
            background: token.colorFillQuaternary,
            border: `1px dashed ${token.colorBorder}`,
            borderRadius: 16,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {videoUrl ? (
            <video src={videoUrl} controls autoPlay style={{ width: '100%', borderRadius: 16, background: '#000' }} />
          ) : generating ? (
            <Text type="secondary">生成中（约 1-3 分钟，请勿离开）…</Text>
          ) : (
            <>
              <PlayCircleOutlined style={{ fontSize: 40, color: token.colorTextQuaternary }} />
              <Text type="secondary">暂无视频</Text>
            </>
          )}
        </div>
      </div>

      {/* 从我的资料选择首帧 */}
      <Modal
        title="从「我的资料」选择首帧图"
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        footer={null}
        width={720}
      >
        {assets.length === 0 ? (
          <Text type="secondary">还没有图片资料，先去「AI 生图」生成一张，或直接上传文件</Text>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 12,
              maxHeight: 420,
              overflowY: 'auto',
            }}
          >
            {assets.map((a) => (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setFirstFrame({ assetId: a.id, url: fileUrl(`/api/media/assets/${a.id}/file`) });
                  setPickerOpen(false);
                  message.success(`已选择「${a.title}」作为首帧`);
                }}
                onKeyDown={(e) => e.key === 'Enter' && setFirstFrame({ assetId: a.id, url: fileUrl(`/api/media/assets/${a.id}/file`) })}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 10,
                  padding: 8,
                  cursor: 'pointer',
                  background: token.colorBgContainer,
                }}
              >
                <div style={{ height: 84, borderRadius: 8, background: token.colorPrimaryBg, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 6 }}>
                  <img src={fileUrl(`/api/media/assets/${a.id}/file`)} alt={a.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <Text style={{ fontSize: 12 }} ellipsis>
                  <PictureOutlined style={{ marginRight: 4 }} />
                  {a.title}
                </Text>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
