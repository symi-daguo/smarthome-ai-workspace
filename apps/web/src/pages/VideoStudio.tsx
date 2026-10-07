import {
  DownOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { App as AntApp, Button, Grid, Select, Typography, Upload, theme } from 'antd';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { INK_BLACK } from '../theme/tokens';

const { Text, Title } = Typography;

const SCENES = ['观影模式', '会客模式', '就餐模式', '起夜模式', '灯光调节'];

const SCENE_HINTS: Record<string, string> = {
  观影模式: '固定机位，窗帘缓缓关闭，电视打开，灯光逐渐变暗，持续到片尾。',
  会客模式: '镜头缓推，客厅主灯与灯带渐亮至会客亮度，氛围温暖明亮。',
  就餐模式: '餐桌上方吊灯渐亮，餐边灯带同步亮起，色调暖白。',
  起夜模式: '夜晚走廊与床底感应灯带以 10% 低亮度缓缓亮起，不刺眼。',
  灯光调节: '同一空间内灯光从冷白渐变到暖黄，展示色温调节效果。',
};

const MODELS = [
  { value: 'pro', label: '智居视频 Pro · 默认' },
  { value: 'fast', label: '智居视频 Fast · 快速' },
];

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

const SOUNDS = [
  { value: 'mute', label: '静音' },
  { value: 'ambient', label: '环境音' },
  { value: 'music', label: '背景音乐' },
];

export function VideoStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;
  const [scene, setScene] = useState<string | null>(null);
  const [desc, setDesc] = useState('');
  const [model, setModel] = useState('pro');
  const [duration, setDuration] = useState('10');
  const [res, setRes] = useState('720');
  const [ratio, setRatio] = useState('16:9');
  const [sound, setSound] = useState('mute');
  const [tailOpen, setTailOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const pickScene = (s: string): void => {
    setScene(s);
    setDesc(SCENE_HINTS[s] ?? '');
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
        }),
      });
      setVideoUrl(fileUrl(`${r.url}?t=${Date.now()}`));
      message.success('视频已生成并保存到「我的资料」');
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const labelStyle: CSSProperties = { fontSize: 13, color: token.colorTextSecondary, marginBottom: 6, display: 'block' };

  return (
    <div style={{ paddingBottom: 24 }}>
      <Title level={3} style={{ marginBottom: 4 }}>AI 视频生成</Title>
      <Text type="secondary">把生成好的智能家居场景图做成 5 秒或 10 秒动态视频</Text>

      <div style={{ display: 'flex', gap: 20, marginTop: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, maxWidth: isWide ? 760 : undefined }}>
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
              ① 首帧图：建议上传客户效果图（也可用生成图作首帧）
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Upload accept="image/*" maxCount={1} showUploadList={false} beforeUpload={() => false}>
                <Button icon={<PlusOutlined />}>选择文件</Button>
              </Upload>
              <a style={{ fontSize: 13 }}>从「我的资料」选择首帧</a>
            </div>
          </div>

          {/* ② 尾帧折叠 */}
          <div style={{ marginBottom: 12 }}>
            <Button
              type="text"
              onClick={() => setTailOpen(!tailOpen)}
              style={{ padding: '6px 0', fontWeight: 600 }}
            >
              <PlayCircleOutlined style={{ marginRight: 6 }} />
              ② 尾帧图（可选）
              <DownOutlined style={{ fontSize: 10, marginLeft: 6, transform: tailOpen ? 'rotate(180deg)' : undefined }} />
            </Button>
            {tailOpen ? (
              <div style={{ padding: '4px 0 8px' }}>
                <Upload accept="image/*" maxCount={1} showUploadList={false} beforeUpload={() => false}>
                  <Button icon={<PlusOutlined />}>选择尾帧文件</Button>
                </Upload>
              </div>
            ) : null}
          </div>

          {/* ③ 预设场景 */}
          <div style={{ marginBottom: 14 }}>
            <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 10 }}>③ 预设智能场景</Text>
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
              观影、会客、就餐先识别参考图再生成专属描述；起夜和灯光调节可直接填入预设
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

          {/* 模型 */}
          <div style={{ marginBottom: 14 }}>
            <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 8 }}>模型</Text>
            <Select value={model} onChange={setModel} options={MODELS} style={{ width: '100%' }} size="large" />
          </div>

          {/* 参数 4 列 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
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
            <div>
              <span style={labelStyle}>声音模式</span>
              <Select value={sound} onChange={setSound} options={SOUNDS} style={{ width: '100%' }} />
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
              声音由模型按说明生成，分类和混合比例以成片试听为准
            </Text>
          </div>
        </div>

        {/* 右：预览 */}
        <div
          style={{
            width: isWide ? 420 : 320,
            flex: 'none',
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
    </div>
  );
}
