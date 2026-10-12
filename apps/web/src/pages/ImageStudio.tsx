import {
  BulbOutlined,
  DeleteOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { App as AntApp, Button, Grid, Select, Spin, Typography, Upload, theme } from 'antd';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { compressImage } from '../lib/compress';
import { INK_BLACK, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

/** 智能场景（17 个常用场景）；点击即把完整画面描述写入提示词输入框 */
const SCENES = [
  '观影模式', '会客模式', '就餐模式', '起夜模式', '阅读模式', '浪漫模式',
  '派对模式', '晨起模式', '工作模式', '节日模式', '淡彩光', '归家模式',
  '离家模式', '烹饪模式', '午休模式', '健身模式', '电竞模式',
];

/** 场景 -> 完整出图描述（点击 chip 直接追加到 textarea，可见、可删、可改，复刻「chip 自动填描述」） */
const SCENE_PROMPTS: Record<string, string> = {
  观影模式: '现代家庭影院客厅，电动窗帘缓缓关闭，壁挂电视亮起冷色画面光，主灯熄灭、吊顶灯带与地脚灯渐暗至 20% 暖光，沙发区保留柔和微光，真实室内摄影质感，电影感色调，广角镜头',
  会客模式: '明亮通透的现代客厅，主灯与吊顶灯带渐亮至会客亮度 4000K 暖白光，茶几区域光线均匀，空间整洁温馨，真实室内摄影质感，平视广角',
  就餐模式: '餐厅场景，餐桌上方三头吊灯渐亮聚焦餐桌，餐边柜灯带同步亮起，3000K 暖白色调，餐具与花艺点缀，真实室内摄影质感，浅景深',
  起夜模式: '深夜卧室到走廊动线，人体感应触发床底灯带与走廊地脚灯以 10% 低亮度微光照明，2700K 柔光不刺眼，地面有柔和光带，真实室内摄影质感，夜间氛围',
  阅读模式: '书房/卧室阅读角，书桌台灯重点照明充足显色性好，环境光柔和无眩光，书架背景整洁，3500K 中性光，真实室内摄影质感',
  浪漫模式: '卧室浪漫氛围，低色温 2200K 暖光，床头壁灯与灯带调至最柔，隐约烛光氛围，纱帘半透，暗调高级感，真实室内摄影质感',
  派对模式: '客厅派对场景，RGB 彩色律动灯带沿吊顶与电视墙铺陈，紫蓝粉光影交替，活力动感氛围，烟雾光束感，真实室内摄影质感',
  晨起模式: '清晨卧室，窗帘缓缓打开透入自然光，灯光模拟日出由暖黄渐亮至冷白 5000K，唤醒氛围，床上用品整洁，真实室内摄影质感，逆光柔和',
  工作模式: '居家办公场景，明亮均匀的 5000K 功能照明，书桌区域无阴影，屏幕无眩光反射，空间清爽现代，真实室内摄影质感',
  节日模式: '春节/节日家庭场景，红色节日彩灯与暖白主灯交织，客厅有精致装饰挂件，喜庆而不俗气，真实室内摄影质感',
  淡彩光: '客厅低饱和淡彩氛围光，墙面与吊顶有粉蓝紫柔和渐变洗墙光，现代极简家具，梦幻而高级，真实室内摄影质感',
  归家模式: '入户玄关视角，开门瞬间玄关感应灯亮起，客厅灯光由近及远渐次点亮，欢迎回家的温暖动线，3000K 暖光，真实室内摄影质感',
  离家模式: '全屋灯光依次关闭后的空镜，仅门廊保留一盏夜灯，窗外自然光，整洁安静的现代家居，真实室内摄影质感',
  烹饪模式: '现代厨房，操作台上方高亮度显色照明，油烟机与橱柜灯带联动无暗区，不锈钢与石材质感，4000K 白光，真实室内摄影质感',
  午休模式: '午后卧室，纱帘半闭透入柔和漫射光，灯光渐暗至 20%，空调面板微光，安静休憩氛围，真实室内摄影质感',
  健身模式: '家庭健身角，明亮 5000K 白光均匀照明，镜面墙与运动器材，动感节奏氛围，干净利落，真实室内摄影质感',
  电竞模式: '电竞房，桌面与背景墙蓝紫色 RGB 氛围光，双显示器冷光，灯带控制屏幕反光，赛博朋克氛围，真实室内摄影质感',
};

const MODELS = [
  { value: 'pro', label: '智居 image pro · 精修' },
  { value: 'fast', label: '智居 image fast · 快速出图' },
];

const SIZES = [
  { value: '1536x1024', label: '横图 1536x1024' },
  { value: '1024x1536', label: '竖图 1024x1536' },
  { value: '1024x1024', label: '方图 1024x1024' },
];

/** 案例库：点击把完整画面描述写入提示词（不是半句占位），真正可直接生成 */
const CASES: { key: string; title: string; img: string; prompt: string }[] = [
  { key: 'c1', title: '全屋智能方案海报', img: '/images/cases/c1.jpg', prompt: '竖版智能家居全屋方案宣传海报，现代轻奢客厅为主体，吊顶灯带与落地灯暖光层次分明，画面上方留白配标题区，中央可见智能中控屏与智能音箱，科技蓝点缀光效，商业摄影级质感，干净高级' },
  { key: 'c2', title: '客厅观影场景', img: '/images/cases/c2.jpg', prompt: SCENE_PROMPTS['观影模式'] },
  { key: 'c3', title: '玄关归家灯光', img: '/images/cases/c3.jpg', prompt: SCENE_PROMPTS['归家模式'] },
  { key: 'c4', title: '主卧起夜模式', img: '/images/cases/c4.jpg', prompt: SCENE_PROMPTS['起夜模式'] },
  { key: 'c5', title: '餐厅就餐氛围', img: '/images/cases/c5.jpg', prompt: SCENE_PROMPTS['就餐模式'] },
];

function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 10 }}>{children}</Text>;
}

interface RefImage {
  assetId: string;
  url: string;
}

export function ImageStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;
  // 提示词输入框是唯一事实源：chip/案例/反推都写入它，用户可见可编辑
  const [prompt, setPrompt] = useState('');
  const [activeScenes, setActiveScenes] = useState<Set<string>>(new Set());
  const [model, setModel] = useState('pro');
  const [size, setSize] = useState('1536x1024');
  const [refImage, setRefImage] = useState<RefImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(0);
  const preview = history[histIdx] ?? null;

  /** 场景描述以〔场景：…〕标记写入 textarea，切换时精确增删，不污染用户手写内容 */
  const sceneTag = (s: string): string => `〔场景：${SCENE_PROMPTS[s]}〕`;

  const toggleScene = (s: string): void => {
    const tag = sceneTag(s);
    if (activeScenes.has(s)) {
      const next = new Set(activeScenes);
      next.delete(s);
      setActiveScenes(next);
      setPrompt((prev) => prev.replace(tag, '').replace(/\s{2,}/g, ' ').trim());
      return;
    }
    if (activeScenes.size >= 3) {
      message.warning('最多同时选 3 个场景，可先取消一个');
      return;
    }
    setActiveScenes(new Set(activeScenes).add(s));
    setPrompt((prev) => (prev.trim() ? `${prev.trim()} ${tag}` : tag));
  };

  /** 参考图真实上传（复用压缩管线），上传后可一键反推提示词 */
  const onUpload = async (file: File): Promise<boolean> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('参考图仅支持 JPG / PNG / WebP');
      return false;
    }
    setUploading(true);
    try {
      const compressed = await compressImage(file);
      const fd = new FormData();
      fd.append('file', compressed);
      fd.append('title', `参考图-${file.name.replace(/\.[^.]+$/, '').slice(0, 40)}`);
      const res = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      setRefImage({ assetId: res.id, url: fileUrl(res.url) });
      message.success('参考图已上传，点「反推提示词」自动生成同风格画面描述');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading(false);
    }
    return false;
  };

  /** 视觉模型反推：参考图 → 详细提示词回填输入框 */
  const reversePrompt = async (): Promise<void> => {
    if (!refImage) return;
    setReversing(true);
    try {
      const r = await api<{ prompt: string }>('/api/media/images/reverse-prompt', {
        method: 'POST',
        body: JSON.stringify({ assetId: refImage.assetId }),
      });
      setPrompt((prev) => (prev.trim() ? `${r.prompt}\n${prev}` : r.prompt));
      message.success('已按参考图反推出画面描述，可直接生成或继续修改');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setReversing(false);
    }
  };

  const generate = async (): Promise<void> => {
    const full = prompt.trim();
    if (full.length < 4) {
      message.warning('请先填写提示词，或点击下方场景/案例自动填入');
      return;
    }
    setGenerating(true);
    try {
      const r = await api<{ url: string }>('/api/media/images', {
        method: 'POST',
        body: JSON.stringify({ prompt: `${full}，真实室内摄影质感，高清细节，无多余文字水印`, size, model }),
      });
      const url = fileUrl(`${r.url}?t=${Date.now()}`);
      setHistory((prev) => [url, ...prev]);
      setHistIdx(0);
      message.success('图片已生成并保存到「我的资料库」');
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const labelStyle: CSSProperties = { fontSize: 13, color: token.colorTextSecondary, marginBottom: 6, display: 'block' };

  return (
    <div style={pageContainerStyle}>
      <Title level={3} style={{ marginBottom: 4 }}>AI 图片生成</Title>
      <Text type="secondary">点场景/案例自动填入完整提示词，或上传参考图一键反推画面描述，生成同风格空间效果图；结果自动存入「我的资料库」</Text>

      <div style={{ display: 'flex', gap: 20, marginTop: 20, alignItems: 'flex-start', flexWrap: isWide ? 'nowrap' : 'wrap' }}>
        {/* 左：表单 */}
        <div style={{ flex: '1 1 46%', minWidth: 320 }}>
          {/* ① 参考图：真实上传 + 反推提示词 */}
          <div style={{ background: token.colorBgContainer, border: `1.5px solid ${token.colorPrimary}`, borderRadius: 14, padding: '16px 18px', marginBottom: 16 }}>
            <SectionLabel>① 参考图（可选）：上传客户现场图，一键反推同风格提示词</SectionLabel>
            {refImage ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <img src={refImage.url} alt="参考图" style={{ width: 108, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }} />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Button type="primary" ghost size="small" icon={<BulbOutlined />} loading={reversing} onClick={() => void reversePrompt()} style={{ marginBottom: 6 }}>
                    反推提示词
                  </Button>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>由视觉模型读出风格/色调/构图，自动写入下方描述</Text></div>
                </div>
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setRefImage(null)}>移除</Button>
              </div>
            ) : (
              <Upload accept="image/jpeg,image/png,image/webp" maxCount={1} showUploadList={false} beforeUpload={(f) => void onUpload(f)}>
                <Button icon={<PlusOutlined />} loading={uploading}>选择参考图</Button>
              </Upload>
            )}
          </div>

          {/* 提示词（唯一事实源） */}
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>② 画面描述（点场景/案例自动填入，可直接编辑）</SectionLabel>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="点下方任意场景，或上传参考图点「反推提示词」，这里会自动出现完整画面描述。也可以手写，例如：现代客厅，暖色灯带渐亮，观影氛围，真实室内摄影质感，16:9"
              style={{
                width: '100%', minHeight: 128, padding: '12px 14px', borderRadius: 12,
                border: `1px solid ${token.colorBorder}`, background: token.colorBgContainer,
                color: token.colorText, fontSize: 14, lineHeight: 1.7, resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </div>

          {/* 场景 chip：点击即写 textarea */}
          <div style={{ marginBottom: 8 }}>
            <SectionLabel>③ 智能场景（选 1～3 个，点击自动填入画面描述）</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SCENES.map((s) => {
                const active = activeScenes.has(s);
                return (
                  <span
                    key={s}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleScene(s)}
                    onKeyDown={(e) => e.key === 'Enter' && toggleScene(s)}
                    title={SCENE_PROMPTS[s]}
                    style={{
                      padding: '7px 16px', borderRadius: 9999, fontSize: 14, fontWeight: 600,
                      cursor: 'pointer', userSelect: 'none',
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
          </div>

          {/* 模型 */}
          <div style={{ margin: '18px 0 12px' }}>
            <SectionLabel>④ 模型</SectionLabel>
            <Select value={model} onChange={setModel} options={MODELS} style={{ width: '100%' }} size="large" />
          </div>

          {/* 参数 */}
          <div style={{ display: 'grid', gridTemplateColumns: isWide ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)', gap: 12, marginBottom: 20 }}>
            <div><span style={labelStyle}>尺寸</span><Select value={size} onChange={setSize} options={SIZES} style={{ width: '100%' }} /></div>
            <div><span style={labelStyle}>质量</span><Select value="medium" options={[{ value: 'medium', label: '标准' }]} style={{ width: '100%' }} disabled /></div>
            <div><span style={labelStyle}>格式</span><Select value="png" options={[{ value: 'png', label: 'PNG' }]} style={{ width: '100%' }} disabled /></div>
            <div><span style={labelStyle}>背景</span><Select value="auto" options={[{ value: 'auto', label: '自动' }]} style={{ width: '100%' }} disabled /></div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <Button
              size="large" loading={generating} onClick={() => void generate()} icon={<ThunderboltFilled />}
              style={{ height: 50, paddingInline: 28, borderRadius: 9999, background: INK_BLACK, color: '#fff', border: 'none', fontWeight: 700, boxShadow: 'none' }}
            >
              {generating ? '生成中（约 15 秒）' : '生成图片'}
            </Button>
            <Text type="secondary" style={{ fontSize: 13 }}>每张按额度扣费，生成结果自动保存到「我的资料库」并可直接用作生视频首帧</Text>
          </div>
        </div>

        {/* 右：预览 */}
        <div
          style={{
            flex: isWide ? '1 1 54%' : '1 1 100%',
            minWidth: 360, minHeight: 380,
            background: token.colorFillQuaternary, border: `1px dashed ${token.colorBorder}`, borderRadius: 16,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, overflow: 'hidden',
          }}
        >
          {preview ? (
            <>
              <img src={preview} alt="生成结果" style={{ width: '100%', borderRadius: 16 }} />
              {history.length > 1 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 10 }}>
                  <Button size="small" shape="circle" icon={<LeftOutlined />} disabled={histIdx >= history.length - 1} onClick={() => setHistIdx((i) => Math.min(history.length - 1, i + 1))} />
                  <Text type="secondary" style={{ fontSize: 12 }}>{history.length - histIdx} / {history.length}（本次会话）</Text>
                  <Button size="small" shape="circle" icon={<RightOutlined />} disabled={histIdx === 0} onClick={() => setHistIdx((i) => Math.max(0, i - 1))} />
                </div>
              ) : null}
            </>
          ) : generating ? (
            <Spin tip="生成中…" size="large"><div style={{ width: 200, height: 120 }} /></Spin>
          ) : (
            <>
              <PlusOutlined style={{ fontSize: 40, color: token.colorTextQuaternary }} />
              <Text type="secondary">暂无图片，选好提示词后点「生成图片」</Text>
            </>
          )}
        </div>
      </div>

      {/* 案例库横滚：点击填入完整描述 */}
      <div style={{ marginTop: 28 }}>
        <SectionLabel>案例库（点击把完整画面描述写入输入框）</SectionLabel>
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {CASES.map((c) => (
            <div
              key={c.key}
              role="button"
              tabIndex={0}
              onClick={() => { setPrompt(c.prompt); message.info(`已填入「${c.title}」画面描述，可直接生成`); }}
              onKeyDown={(e) => e.key === 'Enter' && setPrompt(c.prompt)}
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
    </div>
  );
}
