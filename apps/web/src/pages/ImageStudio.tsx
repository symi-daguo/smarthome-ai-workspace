import {
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { App as AntApp, Button, Grid, Select, Typography, Upload, theme } from 'antd';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { INK_BLACK } from '../theme/tokens';

const { Text, Title } = Typography;

/** 智能场景（行业通用术语，17 个常用场景） */
const SCENES = [
  '观影模式', '会客模式', '就餐模式', '起夜模式', '阅读模式', '浪漫模式',
  '派对模式', '晨起模式', '工作模式', '节日模式', '淡彩光', '归家模式',
  '离家模式', '烹饪模式', '午休模式', '健身模式', '电竞模式',
];

/** 场景 -> 出图描述补充（选中场景自动融入 prompt） */
const SCENE_PROMPTS: Record<string, string> = {
  观影模式: '窗帘关闭、电视亮起、灯光渐暗的家庭影院氛围',
  会客模式: '主灯与灯带渐亮至会客亮度、温暖明亮',
  就餐模式: '餐桌吊灯渐亮、餐边灯带同步、暖白色调',
  起夜模式: '夜间走廊与床底感应灯带 10% 低亮度微光',
  阅读模式: '书桌重点照明充足、环境光柔和不刺眼',
  浪漫模式: '低色温暖光、烛光氛围、灯光调至最柔',
  派对模式: 'RGB 彩色律动灯光、活力氛围',
  晨起模式: '模拟日出的渐亮冷白光、窗帘缓缓打开',
  工作模式: '明亮均匀的功能照明、屏幕无眩光',
  节日模式: '节日彩灯与暖光交织、装饰氛围',
  淡彩光: '低饱和淡彩氛围光、墙面柔和渐变',
  归家模式: '进门瞬间玄关灯亮起、客厅灯渐次点亮',
  离家模式: '全屋灯光关闭、仅留门廊夜灯',
  烹饪模式: '厨房操作台高亮度照明、油烟机联动',
  午休模式: '光线渐暗至 20%、窗帘半闭',
  健身模式: '明亮白光、动感节奏氛围',
  电竞模式: '蓝紫电竞氛围光、屏幕反光控制',
};

const MODELS = [
  { value: 'pro', label: '智居 image pro · 精修（支持参考图）' },
  { value: 'fast', label: '智居 image fast · 快速出图' },
];

const SIZES = [
  { value: '1536x1024', label: '横图 1536x1024' },
  { value: '1024x1536', label: '竖图 1024x1536' },
  { value: '1024x1024', label: '方图 1024x1024' },
];

/** 自有案例（本地生成图，public/images/cases/） */
const CASES = [
  { key: 'c1', title: '全屋智能方案海报', img: '/images/cases/c1.jpg' },
  { key: 'c2', title: '客厅观影场景', img: '/images/cases/c2.jpg' },
  { key: 'c3', title: '玄关归家灯光', img: '/images/cases/c3.jpg' },
  { key: 'c4', title: '主卧起夜模式', img: '/images/cases/c4.jpg' },
  { key: 'c5', title: '餐厅就餐氛围', img: '/images/cases/c5.jpg' },
];

function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <Text strong style={{ display: 'block', fontSize: 15, marginBottom: 10 }}>
      {children}
    </Text>
  );
}

export function ImageStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;
  const [scenes, setScenes] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('pro');
  const [size, setSize] = useState('1536x1024');
  // 本次会话生成历史（可左右翻页回看）
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(0);
  const [generating, setGenerating] = useState(false);
  const preview = history[histIdx] ?? null;

  const toggleScene = (s: string): void => {
    setScenes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : prev.length >= 3 ? prev : [...prev, s],
    );
  };

  const generate = async (): Promise<void> => {
    const sceneDesc = scenes.map((s) => SCENE_PROMPTS[s]).filter(Boolean).join('；');
    const full = [prompt.trim(), sceneDesc ? `场景：${sceneDesc}` : ''].filter(Boolean).join('，');
    if (!full) {
      message.warning('请先填写提示词或选择智能场景');
      return;
    }
    setGenerating(true);
    try {
      const r = await api<{ url: string }>('/api/media/images', {
        method: 'POST',
        body: JSON.stringify({ prompt: `${full}，真实室内摄影质感`, size, model }),
      });
      const url = fileUrl(`${r.url}?t=${Date.now()}`);
      setHistory((prev) => [url, ...prev]);
      setHistIdx(0);
      message.success('图片已生成并保存到「我的资料」');
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const labelStyle: CSSProperties = { fontSize: 13, color: token.colorTextSecondary, marginBottom: 6, display: 'block' };

  return (
    <div style={{ paddingBottom: 24 }}>
      <Title level={3} style={{ marginBottom: 4 }}>AI 图片生成</Title>
      <Text type="secondary">生成智能家居空间效果图、氛围灯光图和方案配图，支持上传客户现场图作参考</Text>

      <div style={{ display: 'flex', gap: 20, marginTop: 20, alignItems: 'flex-start' }}>
        {/* 左：表单 */}
        <div style={{ flex: 1, minWidth: 0, maxWidth: isWide ? 760 : undefined }}>
          {/* ① 参考图 */}
          <div
            style={{
              background: token.colorBgContainer,
              border: `1.5px solid ${token.colorPrimary}`,
              borderRadius: 14,
              padding: '16px 18px',
              marginBottom: 16,
            }}
          >
            <SectionLabel>① 参考图：先上传客户现场图（可选，智能家居场景强烈建议先传）</SectionLabel>
            <Upload
              accept="image/*"
              maxCount={1}
              showUploadList={false}
              beforeUpload={() => {
                message.info('参考图精修将在 0.2.0 接入图生图模型后开放，当前按文字描述生成');
                return false;
              }}
            >
              <Button icon={<PlusOutlined />}>选择文件</Button>
            </Upload>
          </div>

          {/* 提示词 */}
          <div style={{ marginBottom: 16 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述空间、灯光氛围与镜头角度，例如：现代客厅，暖色灯带渐亮，观影氛围，真实室内摄影质感，16:9"
              style={{
                width: '100%',
                minHeight: 96,
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
          </div>

          {/* 场景 chip */}
          <div style={{ marginBottom: 8 }}>
            <SectionLabel>② 智能场景（选 1～3 个，自动融入画面描述）</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SCENES.map((s) => {
                const active = scenes.includes(s);
                return (
                  <span
                    key={s}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleScene(s)}
                    onKeyDown={(e) => e.key === 'Enter' && toggleScene(s)}
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
          </div>

          {/* 模型 */}
          <div style={{ margin: '18px 0 12px' }}>
            <SectionLabel>③ 模型</SectionLabel>
            <Select
              value={model}
              onChange={setModel}
              options={MODELS}
              style={{ width: '100%' }}
              size="large"
            />
          </div>

          {/* 参数 */}
          <div style={{ display: 'grid', gridTemplateColumns: isWide ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)', gap: 12, marginBottom: 20 }}>
            <div>
              <span style={labelStyle}>尺寸</span>
              <Select value={size} onChange={setSize} options={SIZES} style={{ width: '100%' }} />
            </div>
            <div>
              <span style={labelStyle}>质量</span>
              <Select value="medium" options={[{ value: 'medium', label: '标准' }]} style={{ width: '100%' }} disabled />
            </div>
            <div>
              <span style={labelStyle}>格式</span>
              <Select value="png" options={[{ value: 'png', label: 'PNG' }]} style={{ width: '100%' }} disabled />
            </div>
            <div>
              <span style={labelStyle}>背景</span>
              <Select value="auto" options={[{ value: 'auto', label: '自动' }]} style={{ width: '100%' }} disabled />
            </div>
          </div>

          {/* 生成按钮 */}
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
              {generating ? '生成中（约 15 秒）' : '生成图片'}
            </Button>
            <Text type="secondary" style={{ fontSize: 13 }}>
              每张按额度扣费（单价由部署者配置），生成结果自动保存到「我的资料」
            </Text>
          </div>
        </div>

        {/* 右：预览 */}
        <div
          style={{
            width: isWide ? 460 : 320,
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
            overflow: 'hidden',
          }}
        >
          {preview ? (
            <>
              <img src={preview} alt="生成结果" style={{ width: '100%', borderRadius: 16 }} />
              {history.length > 1 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 10 }}>
                  <Button
                    size="small"
                    shape="circle"
                    icon={<LeftOutlined />}
                    disabled={histIdx >= history.length - 1}
                    onClick={() => setHistIdx((i) => Math.min(history.length - 1, i + 1))}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {history.length - histIdx} / {history.length}（本次会话）
                  </Text>
                  <Button
                    size="small"
                    shape="circle"
                    icon={<RightOutlined />}
                    disabled={histIdx === 0}
                    onClick={() => setHistIdx((i) => Math.max(0, i - 1))}
                  />
                </div>
              ) : null}
            </>
          ) : generating ? (
            <Text type="secondary">生成中…</Text>
          ) : (
            <>
              <PlusOutlined style={{ fontSize: 40, color: token.colorTextQuaternary }} />
              <Text type="secondary">暂无图片</Text>
            </>
          )}
        </div>
      </div>

      {/* 案例库横滚 */}
      <div style={{ marginTop: 28 }}>
        <SectionLabel>案例库（左右滑动查看，点击填入描述）</SectionLabel>
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {CASES.map((c) => (
            <div
              key={c.key}
              role="button"
              tabIndex={0}
              onClick={() => setPrompt(`参考「${c.title}」的风格：`)}
              onKeyDown={(e) => e.key === 'Enter' && setPrompt(`参考「${c.title}」的风格：`)}
              style={{
                width: 220,
                flex: 'none',
                height: 130,
                borderRadius: 12,
                background: `url(${c.img}) center/cover no-repeat`,
                border: `1px solid ${token.colorBorderSecondary}`,
                display: 'flex',
                alignItems: 'flex-end',
                padding: 12,
                cursor: 'pointer',
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
