import {
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { App as AntApp, Alert, Button, Grid, Input, Modal, Select, Typography, Upload, theme } from 'antd';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { useActiveConfig } from '../lib/configStore';
import {
  AUDIO_MODES, DEFAULT_EFFECTS, DEFAULT_MUSIC, MAX_EFFECTS_LEN, MAX_MUSIC_LEN,
  audioSupportHint, normalizeAudio, withAudioPrompt, type AudioMode,
} from '../lib/videoAudio';
import { INK_BLACK, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

const SCENES = ['观影模式', '会客模式', '就餐模式', '起夜模式', '灯光调节', '归家动线', '晨起唤醒', '窗帘开合'];

const SCENE_HINTS: Record<string, string> = {
  观影模式: '固定中景机位，电动窗帘缓缓关闭，壁挂电视打开投出冷色画面光，客厅主灯熄灭、吊顶灯带与地脚灯在 3 秒内渐变暗至 20% 暖光，沙发区保留柔和微光，镜头缓慢推进，电影感氛围持续到片尾。',
  会客模式: '镜头从玄关缓慢推向客厅，主灯与吊顶灯带渐亮至 4000K 会客亮度，茶几区域光线均匀变暖，人物落座后灯光稳定在明亮温馨状态，画面平稳。',
  就餐模式: '餐厅固定机位略带环绕，餐桌上方三头吊灯由暗渐亮聚焦餐桌，餐边柜灯带同步亮起至 3000K 暖白，餐具与花艺在暖光下清晰，氛围温馨。',
  起夜模式: '夜间低照度画面，人物脚落地触发感应，床底灯带先以 10% 微光缓缓亮起，镜头跟随脚步沿走廊移动，地脚灯逐点点亮、2700K 柔光不刺眼，回到床上后灯光渐隐。',
  灯光调节: '同一空间固定机位，全屋灯光在 5 秒内从 5000K 冷白平滑渐变到 2700K 暖黄，墙面洗墙光颜色同步过渡，直观展示色温无级调节。',
  归家动线: '第一视角入户动线，开门瞬间玄关感应灯亮起，镜头向前移动，客厅灯光由近及远依次点亮，窗帘缓缓合拢，最终落到客厅全景暖光欢迎状态。',
  晨起唤醒: '清晨卧室延时感画面，窗帘缓缓向两侧打开透入自然光，室内灯光模拟日出由 2700K 暖黄渐亮至 5000K 冷白，人物伸腰起床，画面明亮柔和。',
  窗帘开合: '窗边侧向固定机位，电动窗帘电机启动，窗帘沿轨道匀速开合，室外自然光随帘布移动在地板上拉出移动光斑，镜头微微横移展示开合全过程。',
};

/** 视频案例（点击把完整分镜描述写入文本框），图取自本地案例素材 */
const VIDEO_CASES: { key: string; title: string; img: string; prompt: string }[] = [
  { key: 'v1', title: '客厅观影短片', img: '/images/cases/c2.jpg', prompt: SCENE_HINTS['观影模式'] },
  { key: 'v2', title: '归家第一视角', img: '/images/cases/c3.jpg', prompt: SCENE_HINTS['归家动线'] },
  { key: 'v3', title: '主卧起夜跟拍', img: '/images/cases/c4.jpg', prompt: SCENE_HINTS['起夜模式'] },
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
  const { config } = useActiveConfig();
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;
  const [scene, setScene] = useState<string | null>(null);
  const [desc, setDesc] = useState('');
  const [duration, setDuration] = useState('10');
  const [res, setRes] = useState('720');
  const [ratio, setRatio] = useState('16:9');
  const [audioMode, setAudioMode] = useState<AudioMode>('silent');
  const [musicStyle, setMusicStyle] = useState(DEFAULT_MUSIC);
  const [soundEffects, setSoundEffects] = useState(DEFAULT_EFFECTS);
  const [firstFrame, setFirstFrame] = useState<FirstFrame | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** 提交幂等键：失败保留、成功清除，详见 lib/request-id.ts */
  const reqIdRef = useRef<string | null>(null);

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
    const rid = reqIdRef.current ?? newRequestId();
    reqIdRef.current = rid;
    try {
      // 音轨不是上游独立参数，而是编译进提示词交给模型理解
      const audio = normalizeAudio(audioMode, musicStyle, soundEffects);
      const fullPrompt = withAudioPrompt(desc.trim(), audio);
      const r = await api<{ url: string; deduped?: boolean }>('/api/media/videos', {
        method: 'POST',
        body: JSON.stringify({
          prompt: fullPrompt,
          duration: Number(duration),
          resolution: `${res}P`,
          ratio,
          ...(firstFrame ? { firstFrameAssetId: firstFrame.assetId } : {}),
          clientRequestId: rid,
        }),
      });
      reqIdRef.current = null;
      setVideoUrl(fileUrl(`${r.url}?t=${Date.now()}`));
      message.success(
        r.deduped
          ? '这次提交此前已成功出片，直接取回原视频（未重复扣额度）'
          : firstFrame ? '视频已生成（图生视频）并保存到「我的资料库」' : '视频已生成并保存到「我的资料库」',
      );
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
              ① 首帧图（可选）：上传或用「我的资料库」里的效果图，作为视频第一帧
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
                <Button type="link" size="small" onClick={() => void openPicker()}>从「我的资料库」选择</Button>
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

          {/* 声音设置：编译进提示词，最终能否出声取决于「模型配置」里配的视频模型 */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={labelStyle}>声音</span>
              <Text type="secondary" style={{ fontSize: 12 }}>
                声音不是独立开关，而是写进画面描述交给模型生成
              </Text>
            </div>
            <Select
              value={audioMode}
              onChange={setAudioMode}
              options={AUDIO_MODES.map((m) => {
                const hint = audioSupportHint(config.videoProvider, config.videoModel ?? '', m.value);
                return { value: m.value, label: m.label, disabled: Boolean(hint) };
              })}
              style={{ width: '100%' }}
            />
            {audioSupportHint(config.videoProvider, config.videoModel ?? '', audioMode) && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                message={audioSupportHint(config.videoProvider, config.videoModel ?? '', audioMode)}
              />
            )}
            {(audioMode === 'music' || audioMode === 'both') && (
              <div style={{ marginTop: 10 }}>
                <span style={labelStyle}>音乐风格</span>
                <Input
                  value={musicStyle}
                  onChange={(e) => setMusicStyle(e.target.value)}
                  maxLength={MAX_MUSIC_LEN}
                  placeholder="例如：轻柔、低音量的无歌词器乐"
                />
              </div>
            )}
            {(audioMode === 'effects' || audioMode === 'both') && (
              <div style={{ marginTop: 10 }}>
                <span style={labelStyle}>音效说明</span>
                <Input.TextArea
                  value={soundEffects}
                  onChange={(e) => setSoundEffects(e.target.value)}
                  maxLength={MAX_EFFECTS_LEN}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder="例如：只保留画面中实际动作的轻微环境音效"
                />
              </div>
            )}
            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12, lineHeight: 1.7 }}>
              静音模式不会往提示词里追加任何声音描述；选有声模式时会把你的音乐/音效要求拼到画面描述后面。
              分类与混音比例请以成片试听为准。
            </Text>
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

      {/* 视频案例：点击填入完整分镜描述 */}
      <div style={{ marginTop: 28 }}>
        <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 10 }}>视频案例（点击把分镜描述写入文本框，建议先在「AI 生图」出图再作首帧）</Text>
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {VIDEO_CASES.map((c) => (
            <div
              key={c.key}
              role="button"
              tabIndex={0}
              onClick={() => { setDesc(c.prompt); setScene(null); message.info(`已填入「${c.title}」分镜描述，可直接生成`); }}
              onKeyDown={(e) => e.key === 'Enter' && setDesc(c.prompt)}
              style={{
                width: 220, flex: 'none', height: 130, borderRadius: 12,
                background: `url(${c.img}) center/cover no-repeat`,
                border: `1px solid ${token.colorBorderSecondary}`,
                display: 'flex', alignItems: 'flex-end', padding: 12, cursor: 'pointer',
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: 600, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,.6)' }}>{c.title}</Text>
            </div>
          ))}
        </div>
      </div>

      {/* 从我的资料库选择首帧 */}
      <Modal
        title="从「我的资料库」选择首帧图"
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
