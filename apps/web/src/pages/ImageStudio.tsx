import {
  AppstoreOutlined,
  BulbOutlined,
  DeleteOutlined,
  HighlightOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  ThunderboltFilled,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, App as AntApp, Button, Empty, Grid, Input, Modal, Segmented, Select, Space, Spin, Typography, Upload, theme } from 'antd';
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IMAGE_WORKFLOWS,
  emptyDraft,
  getWorkflow,
  missingItems,
  parseCoverCopy,
  recommendedSize,
  type WorkflowDraft,
  type WorkflowKey,
} from '../data/imageWorkflows';
import { api, fileUrl } from '../lib/api';
import { compressImage } from '../lib/compress';
import { RegionSelector, type RegionSelection } from '../components/RegionSelector';
import { useActiveConfig } from '../lib/configStore';
import { INK_BLACK, pageContainerStyle } from '../theme/tokens';

const { Text, Title } = Typography;

/** 智能场景（17 个常用场景）；自由生图模式下点击即把完整画面描述写入提示词输入框 */
const SCENES = [
  '观影模式', '会客模式', '就餐模式', '起夜模式', '阅读模式', '浪漫模式',
  '派对模式', '晨起模式', '工作模式', '节日模式', '淡彩光', '归家模式',
  '离家模式', '烹饪模式', '午休模式', '健身模式', '电竞模式',
];

/** 场景 -> 完整出图描述（自由生图模式点击 chip 直接追加到 textarea，可见、可删、可改，复刻「chip 自动填描述」） */
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

/** 换行文本 <-> 字符串数组：封面标签与卖点用数组存，用多行文本编辑 */
function linesToArr(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}
function arrToLines(list: string[]): string {
  return list.join('\n');
}

/** 提交幂等键：失败（尤其超时这种「不知道成没成」）保留复用，成功才清除。
 *  这样弱网重试 / 重复点击会被后端识别成同一次请求，不会二次出图、二次扣额度。 */
const newRequestId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function ImageStudio(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl ?? false;
  // 当前激活的对话模型方案（ConfigProvider 注入），供封面文案一键生成用
  const { config } = useActiveConfig();
  /** 真实生效的生图模型名（来自「模型配置」页），只读展示，不在前端做无效切换 */
  const imageModelName = config.imageModel || config.imageProvider || '未配置';

  // 提示词输入框是唯一事实源：chip/案例/反推/工作流组装都写入它，用户可见可编辑
  const [prompt, setPrompt] = useState('');
  /** 自由生图的场景集合（以〔场景：…〕标记直接写 textarea）；毛坯房模式的场景存在 draft 里 */
  const [activeScenes, setActiveScenes] = useState<Set<string>>(new Set());
  const [size, setSize] = useState('1536x1024');
  /** 适配视频：出图统一 16:9 且保持原图构图，可直接当视频首帧（参考站同款语义） */
  const [fitVideo, setFitVideo] = useState(false);
  /** 背景意图：transparent / white 会写进提示词约束 */
  const [background, setBackground] = useState<'auto' | 'transparent' | 'white'>('auto');
  const [refImage, setRefImage] = useState<RefImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assets, setAssets] = useState<{ id: string; title: string }[]>([]);
  const [reversing, setReversing] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 历史同时留资产 id：圈选局部重绘要把 id 与遮罩一起回传后端，只存 URL 取不到
  const [history, setHistory] = useState<{ id: string; url: string }[]>([]);
  const [histIdx, setHistIdx] = useState(0);
  const preview = history[histIdx] ?? null;
  /** 待圈选重绘的图（存整条记录，重绘成功后要追加新图） */
  const [regionFor, setRegionFor] = useState<{ id: string; url: string } | null>(null);
  const [redrawNote, setRedrawNote] = useState('');
  const [redrawing, setRedrawing] = useState(false);
  const reqIdRef = useRef<string | null>(null);
  const redrawIdRef = useRef<string | null>(null);

  // 工作流状态：切模式只重置本模式的专属字段，参考图与模型保留
  const [wfKey, setWfKey] = useState<WorkflowKey>('free');
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  /** 提示词已被手工改过：之后改选项不覆盖用户输入，只提示可重新组装 */
  const [promptDirty, setPromptDirty] = useState(false);
  const [copying, setCopying] = useState(false);

  const wf = getWorkflow(wfKey);
  const isFree = wfKey === 'free';
  const ratio = wf.sizes.find((s) => s.value === size)?.ratio ?? '';
  const missing = useMemo(
    () => (isFree ? [] : missingItems(wf, draft, refImage !== null)),
    [isFree, wf, draft, refImage],
  );

  /** 按当前草稿与尺寸重算提示词；用户手改过就不覆盖，只在 force 时才强制写回 */
  const syncPrompt = (next: WorkflowDraft, nextSize: string, force: boolean): void => {
    // 自由生图的提示词完全由用户/scene chip/反推维护，组装函数对它返回空串，不能覆盖
    if (isFree) return;
    const r = wf.sizes.find((s) => s.value === nextSize)?.ratio ?? '';
    const text = wf.buildPrompt(next, SCENE_PROMPTS, r);
    if (force || !promptDirty) {
      setPrompt(text);
      setPromptDirty(false);
    }
  };

  /** 更新草稿：比例随风格联动的工作流会顺带切到推荐尺寸 */
  const updateDraft = (next: WorkflowDraft): void => {
    const nextSize = recommendedSize(wf, next.choice) ?? size;
    setSize(nextSize);
    setDraft(next);
    syncPrompt(next, nextSize, false);
  };

  const switchWorkflow = (key: WorkflowKey): void => {
    const next = getWorkflow(key);
    setWfKey(key);
    setDraft(emptyDraft());
    setActiveScenes(new Set());
    setPromptDirty(false);
    setPrompt('');
    setSize(next.defaultSize);
  };

  /** 场景描述以〔场景：…〕标记写入 textarea，切换时精确增删，不污染用户手写内容 */
  const sceneTag = (s: string): string => `〔场景：${SCENE_PROMPTS[s]}〕`;

  /** 自由生图模式：场景直接以标记写进 textarea（保持原行为） */
  const toggleSceneFree = (s: string): void => {
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

  /** 毛坯房模式：场景存在 draft 里，由提示词组装函数统一拼装 */
  const toggleSceneDraft = (s: string): void => {
    if (draft.scenes.includes(s)) {
      updateDraft({ ...draft, scenes: draft.scenes.filter((x) => x !== s) });
      return;
    }
    if (draft.scenes.length >= 3) {
      message.warning('最多同时叠加 3 个灯光场景，可先取消一个');
      return;
    }
    updateDraft({ ...draft, scenes: [...draft.scenes, s] });
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

  /** 从「我的资料库」选参考图（与视频页首帧选择同源，不重复造轮子） */
  const openPicker = async (): Promise<void> => {
    try {
      const list = await api<{ id: string; kind: string; title: string }[]>('/api/media/assets');
      setAssets(list.filter((a) => a.kind === 'image').map((a) => ({ id: a.id, title: a.title })));
    } catch (e) {
      message.error((e as Error).message || '资料库加载失败');
    }
    setPickerOpen(true);
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
      setPromptDirty(true);
      message.success('已按参考图反推出画面描述，可直接生成或继续修改');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setReversing(false);
    }
  };

  /** 封面模式：一键让对话模型产出大标题、侧边标签与 3 条卖点，结果可继续编辑 */
  const genCoverCopy = async (): Promise<void> => {
    const topic = (draft.text.topic ?? '').trim();
    if (!topic) {
      message.warning('请先填写视频主题');
      return;
    }
    const req = getWorkflow('cover').copyPrompt?.(topic);
    if (!req) return;
    setCopying(true);
    try {
      const r = await api<{ reply: string }>('/api/llm/chat', {
        method: 'POST',
        body: JSON.stringify({
          model: config.chatModel || 'MiniMax-M3',
          systemPrompt: req.systemPrompt,
          prompt: req.prompt,
        }),
      });
      const copy = parseCoverCopy(r.reply);
      if (!copy.title) {
        message.warning('模型没给出可用文案，可再点一次或直接手写');
        return;
      }
      updateDraft({ ...draft, copy });
      message.success('标题、标签与卖点已生成，可直接编辑或改写');
    } catch (e) {
      message.error((e as Error).message || '文案生成失败');
    } finally {
      setCopying(false);
    }
  };

  const generate = async (): Promise<void> => {
    if (missing.length > 0) {
      message.warning(`还有必填项没完成：${missing.join('、')}`);
      return;
    }
    const full = prompt.trim();
    if (full.length < 4) {
      message.warning('请先填写提示词，或点击下方场景/案例自动填入');
      return;
    }
    setGenerating(true);
    const rid = reqIdRef.current ?? newRequestId();
    reqIdRef.current = rid;
    try {
      // 自由生图沿用原后缀；各业务工作流的组装文案自带质感与免文字要求，不再重复追加
      const body = isFree ? `${full}，真实室内摄影质感，高清细节，无多余文字水印` : full;
      const r = await api<{ id: string; url: string; deduped?: boolean }>('/api/media/images', {
        method: 'POST',
        body: JSON.stringify({ prompt: body, size, fitVideo, background, clientRequestId: rid }),
      });
      reqIdRef.current = null;
      const url = fileUrl(`${r.url}?t=${Date.now()}`);
      setHistory((prev) => [{ id: r.id, url }, ...prev]);
      setHistIdx(0);
      message.success(r.deduped ? '这次提交此前已成功出图，直接取回原图（未重复扣额度）' : '图片已生成并保存到「我的资料库」');
    } catch (e) {
      message.error((e as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 圈选局部重绘：只重画圈内的区域，圈外保持原始像素（后端走 images/edits）。
   * 提示词用「要改什么」这句人话，不带原图描述——带了模型会把整张按描述重画，
   * 那就不是局部重绘了。不填则退回本次提示词，保证一定能出一个结果。
   */
  const redrawRegion = async (sel: RegionSelection): Promise<void> => {
    const note = redrawNote.trim() || prompt.trim();
    if (note.length < 2) {
      message.warning('先写一句要怎么改，模型才知道圈里要变成什么样');
      return;
    }
    setRedrawing(true);
    const rid = redrawIdRef.current ?? newRequestId();
    redrawIdRef.current = rid;
    try {
      const r = await api<{ id: string; url: string; deduped?: boolean }>('/api/media/images', {
        method: 'POST',
        body: JSON.stringify({
          prompt: note,
          size,
          imageAssetId: sel.imageAssetId,
          maskDataUrl: sel.maskDataUrl,
          clientRequestId: rid,
          title: '局部重绘',
        }),
      });
      redrawIdRef.current = null;
      setRegionFor(null);
      setRedrawNote('');
      setHistory((prev) => [{ id: r.id, url: fileUrl(`${r.url}?t=${Date.now()}`) }, ...prev]);
      setHistIdx(0);
      message.success(r.deduped ? '该次重绘此前已完成，直接取回结果' : '局部已重绘，原图保留在历史里');
    } catch (e) {
      message.error((e as Error).message || '局部重绘失败');
    } finally {
      setRedrawing(false);
    }
  };

  const labelStyle: CSSProperties = { fontSize: 13, color: token.colorTextSecondary, marginBottom: 6, display: 'block' };
  const inputStyle: CSSProperties = { fontFamily: 'inherit' };
  /** 选项 chip 的统一样式：选中态走主题色，未选中走浅灰 */
  const chipStyle = (active: boolean): CSSProperties => ({
    padding: '7px 16px', borderRadius: 9999, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', userSelect: 'none',
    background: active ? token.colorPrimaryBg : token.colorFillQuaternary,
    color: active ? token.colorPrimary : token.colorTextSecondary,
    border: `1px solid ${active ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
  });

  /** 单选/多选组渲染；free 模式无选项组，bare 的场景组由调用方单独处理 */
  const renderGroup = (groupId: string): ReactNode => {
    const group = wf.optionGroups.find((g) => g.id === groupId);
    if (!group) return null;
    return (
      <div style={{ marginBottom: 18 }}>
        <SectionLabel>{group.label}</SectionLabel>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -4, marginBottom: 10 }}>{group.hint}</Text>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {group.options.map((o) => {
            const active = draft.choice === o.value;
            return (
              <span
                key={o.value}
                role="button"
                tabIndex={0}
                title={o.prompt}
                onClick={() => updateDraft({ ...draft, choice: active ? '' : o.value })}
                onKeyDown={(e) => e.key === 'Enter' && updateDraft({ ...draft, choice: active ? '' : o.value })}
                style={chipStyle(active)}
              >
                {o.label}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  const textFieldArea = (fieldId: string): ReactNode => {
    const field = wf.textFields.find((f) => f.id === fieldId);
    if (!field) return null;
    const value = draft.text[field.id] ?? '';
    return (
      <div style={{ marginBottom: 18 }}>
        <SectionLabel>{field.label}</SectionLabel>
        {field.hint ? (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -4, marginBottom: 8 }}>{field.hint}</Text>
        ) : null}
        {field.multiline ? (
          <Input.TextArea
            value={value}
            onChange={(e) => updateDraft({ ...draft, text: { ...draft.text, [field.id]: e.target.value } })}
            placeholder={field.placeholder}
            autoSize={{ minRows: 3, maxRows: 6 }}
            style={inputStyle}
          />
        ) : (
          <Input
            value={value}
            onChange={(e) => updateDraft({ ...draft, text: { ...draft.text, [field.id]: e.target.value } })}
            placeholder={field.placeholder}
            onPressEnter={(e) => e.currentTarget.blur()}
            style={inputStyle}
          />
        )}
      </div>
    );
  };

  /** 封面模式的可编辑文案区：生成后直接改，改完自动重新组装提示词 */
  const coverCopyArea = (): ReactNode => (
    <div style={{ marginBottom: 18 }}>
      <SectionLabel>封面文案（可编辑）</SectionLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Button size="small" icon={<BulbOutlined />} loading={copying} onClick={() => void genCoverCopy()}>
          一键生成标题与卖点
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>由对话模型按主题产出大标题、3-4 个侧边标签与 3 条卖点</Text>
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>大标题（8 字内）</span>
        <Input
          value={draft.copy.title}
          placeholder="例如：全屋智能交付"
          onChange={(e) => updateDraft({ ...draft, copy: { ...draft.copy, title: e.target.value } })}
          style={inputStyle}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>左侧标签（一行一个，3-4 个）</span>
        <Input.TextArea
          value={arrToLines(draft.copy.tags)}
          placeholder={'全屋方案\n免费设计\n本地售后'}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onChange={(e) => updateDraft({ ...draft, copy: { ...draft.copy, tags: linesToArr(e.target.value) } })}
          style={inputStyle}
        />
      </div>
      <div>
        <span style={labelStyle}>右侧卖点（一行一个，3 条）</span>
        <Input.TextArea
          value={arrToLines(draft.copy.sellingPoints)}
          placeholder={'当天调试当天用\n老房不砸墙改造\n三年上门维护'}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onChange={(e) => updateDraft({ ...draft, copy: { ...draft.copy, sellingPoints: linesToArr(e.target.value) } })}
          style={inputStyle}
        />
      </div>
    </div>
  );

  const baseSizeOptions = isFree ? SIZES : wf.sizes.map((s) => ({ value: s.value, label: s.label }));
  const fitVideoOpt = { value: '__fitVideo', label: '跟随参考图 · 适配视频' };
  const sizeOptions = refImage ? [...baseSizeOptions, fitVideoOpt] : baseSizeOptions;

  /** 序号由页面统一给出，数据文件只管字段名，避免两处各写一套圈号导致编号错乱 */
  const stepRef = '①';
  const stepPrompt = isFree ? '②' : '④';
  const stepScene = '③';
  const stepModel = isFree ? '④' : '⑤';

  return (
    <div style={pageContainerStyle}>
      <Title level={3} style={{ marginBottom: 4 }}>AI 图片生成</Title>
      <Text type="secondary">
        {isFree
          ? '点场景/案例自动填入完整提示词，或上传参考图一键反推画面描述，生成同风格空间效果图；结果自动存入「我的资料库」'
          : `${wf.description}；提示词可自由修改，结果自动存入「我的资料库」`}
      </Text>

      {/* 工作流分段控件 */}
      <div style={{ marginTop: 18, marginBottom: 4, overflowX: 'auto' }}>
        <Segmented
          value={wfKey}
          onChange={(v) => switchWorkflow(v as WorkflowKey)}
          options={IMAGE_WORKFLOWS.map((w) => ({ value: w.key, label: w.name }))}
          size="large"
        />
      </div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
        当前流程：{wf.name} · {wf.description}
      </Text>

      <div style={{ display: 'flex', gap: 20, marginTop: 4, alignItems: 'flex-start', flexWrap: isWide ? 'nowrap' : 'wrap', flex: 1, minWidth: 0 }}>
        {/* 左：表单 */}
        <div style={{ flex: '1 1 46%', minWidth: 320 }}>
          {/* ① 参考图：真实上传 + 反推提示词 */}
          <div style={{ background: token.colorBgContainer, border: `1.5px solid ${wf.requiresRef && !refImage ? token.colorError : token.colorPrimary}`, borderRadius: 14, padding: '16px 18px', marginBottom: 16 }}>
            <SectionLabel>{`${stepRef} ${wf.refLabel}`}</SectionLabel>
            {refImage ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <img src={refImage.url} alt="参考图" style={{ width: 108, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }} />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Button type="primary" ghost size="small" icon={<BulbOutlined />} loading={reversing} onClick={() => void reversePrompt()} style={{ marginBottom: 6 }}>
                    反推提示词
                  </Button>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{wf.refHint}</Text></div>
                </div>
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setRefImage(null)}>移除</Button>
              </div>
            ) : (
              <>
                <Space wrap>
                  <Upload accept="image/jpeg,image/png,image/webp" maxCount={1} showUploadList={false} beforeUpload={(f) => void onUpload(f)}>
                    <Button icon={<PlusOutlined />} loading={uploading}>选择参考图</Button>
                  </Upload>
                  <Button icon={<AppstoreOutlined />} onClick={() => void openPicker()}>从「我的资料」选</Button>
                </Space>
                <div style={{ marginTop: 8 }}><Text type="secondary" style={{ fontSize: 12 }}>{wf.refHint}</Text></div>
              </>
            )}
          </div>

          {/* 工作流专属字段：风格 / 节日 / 文案输入 */}
          {wf.key === 'bare' && renderGroup('style')}
          {wf.key === 'poster' && renderGroup('festival')}
          {wf.key === 'colorplan' && renderGroup('style')}
          {wf.key === 'cover' && textFieldArea('topic')}
          {wf.key === 'cover' && coverCopyArea()}

          {/* 必填项未完成提示：不让用户点了生成才报一堆错 */}
          {missing.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              style={{ marginBottom: 16 }}
              message="必填项还没填完"
              description={`还差：${missing.join('、')}`}
            />
          ) : null}

          {/* 画面描述（唯一事实源，工作流模式由选项自动组装） */}
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>
              {`${stepPrompt} 画面描述（${isFree ? '点场景/案例自动填入' : '按上面的选项自动组装'}，可直接编辑）`}
            </SectionLabel>
            {isFree ? null : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: -4, marginBottom: 8, flexWrap: 'wrap' }}>
                <Button size="small" onClick={() => syncPrompt(draft, size, true)}>按当前选项重新组装</Button>
                {promptDirty ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>你已手动改过描述，改选项不会覆盖，点上面按钮可重新组装</Text>
                ) : null}
              </div>
            )}
            <textarea
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
              placeholder="点下方任意场景，或上传参考图点「反推提示词」，这里会自动出现完整画面描述。也可以手写，例如：现代客厅，暖色灯带渐亮，观影氛围，真实室内摄影质感，16:9"
              style={{
                width: '100%', minHeight: 128, padding: '12px 14px', borderRadius: 12,
                border: `1px solid ${token.colorBorder}`, background: token.colorBgContainer,
                color: token.colorText, fontSize: 14, lineHeight: 1.7, resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </div>

          {/* 场景 chip：自由生图写 textarea；毛坯房模式进草稿由组装函数拼装 */}
          <div style={{ marginBottom: 8 }}>
            <SectionLabel>
              {`${stepScene} ${wf.key === 'bare' ? '叠加智能灯光场景（选 1～3 个，点击自动并入描述）' : '智能场景（选 1～3 个，点击自动填入画面描述）'}`}
            </SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SCENES.map((s) => {
                const active = wf.key === 'bare' ? draft.scenes.includes(s) : activeScenes.has(s);
                const toggle = wf.key === 'bare' ? toggleSceneDraft : toggleSceneFree;
                return (
                  <span
                    key={s}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggle(s)}
                    onKeyDown={(e) => e.key === 'Enter' && toggle(s)}
                    title={SCENE_PROMPTS[s]}
                    style={chipStyle(active)}
                  >
                    {s}
                  </span>
                );
              })}
            </div>
          </div>

          {/* 模型：只读展示「模型配置」页当前生效的真实模型，不做无效选择 */}
          <div style={{ margin: '18px 0 12px' }}>
            <SectionLabel>{`${stepModel} 模型`}</SectionLabel>
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '6px 12px', border: `1px solid ${token.colorBorder}`, borderRadius: 8,
                background: token.colorFillQuaternary, fontSize: 13.5,
              }}
            >
              <span>{imageModelName}</span>
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/model-config')}>
                去切换
              </Button>
            </div>
          </div>

          {/* 参数 */}
          <div style={{ display: 'grid', gridTemplateColumns: isWide ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)', gap: 12, marginBottom: 20 }}>
            <div>
              <span style={labelStyle}>{isFree ? '尺寸' : wf.sizes.length > 1 ? '尺寸' : '尺寸（本流程固定）'}</span>
              <Select
                value={size === '__fitVideo' ? '__fitVideo' : size}
                onChange={(v) => {
                  if (v === '__fitVideo') { setFitVideo(true); setSize(baseSizeOptions[0]?.value ?? '1536x1024'); }
                  else { setFitVideo(false); setSize(String(v)); }
                }}
                options={sizeOptions}
                style={{ width: '100%' }}
                disabled={!isFree && wf.sizes.length === 1}
              />
            </div>
            <div>
              <span style={labelStyle}>背景</span>
              <Select
                value={background}
                onChange={setBackground}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'white', label: '纯白背景' },
                  { value: 'transparent', label: '透明背景' },
                ]}
                style={{ width: '100%' }}
              />
            </div>
            {refImage && (
              <div>
                <span style={labelStyle}>适配视频</span>
                <Select
                  value={fitVideo ? 'on' : 'off'}
                  onChange={(v) => setFitVideo(v === 'on')}
                  options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启（16:9 不裁切）' }]}
                  style={{ width: '100%' }}
                />
              </div>
            )}
            {refImage && (
              <div>
                <span style={labelStyle}>构图说明</span>
                <Text type="secondary" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  开启后会按 16:9 出图并保持参考图构图，可直接作为生视频首帧。
                </Text>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <Button
              size="large" loading={generating} onClick={() => void generate()} icon={<ThunderboltFilled />}
              style={{ height: 50, paddingInline: 28, borderRadius: 9999, background: INK_BLACK, color: '#fff', border: 'none', fontWeight: 700, boxShadow: 'none' }}
            >
              {generating ? '生成中（约 15 秒）' : '生成图片'}
            </Button>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {isFree
                ? '每张按额度扣费，生成结果自动保存到「我的资料库」并可直接用作生视频首帧'
                : `本次输出比例：${ratio || '跟随尺寸'}；每张按额度扣费，结果自动存入「我的资料库」`}
            </Text>
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
              <img src={preview.url} alt="生成结果" style={{ width: '100%', borderRadius: 16 }} />
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: '0 10px 12px' }}>
                {history.length > 1 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Button size="small" shape="circle" icon={<LeftOutlined />} disabled={histIdx >= history.length - 1} onClick={() => setHistIdx((i) => Math.min(history.length - 1, i + 1))} />
                    <Text type="secondary" style={{ fontSize: 12 }}>{history.length - histIdx} / {history.length}（本次会话）</Text>
                    <Button size="small" shape="circle" icon={<RightOutlined />} disabled={histIdx === 0} onClick={() => setHistIdx((i) => Math.max(0, i - 1))} />
                  </div>
                ) : null}
                {/* 圈选局部重绘：只有支持遮罩的出图通道才可用，后端对不支持的通道会明确拒绝而不是整张重画 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Input
                    size="small"
                    style={{ flex: 1, minWidth: 160 }}
                    value={redrawNote}
                    onChange={(e) => setRedrawNote(e.target.value)}
                    placeholder="圈里要怎么改？留空则沿用当前提示词"
                    allowClear
                  />
                  <Button
                    size="small"
                    icon={<HighlightOutlined />}
                    loading={redrawing}
                    onClick={() => setRegionFor(preview)}
                  >
                    圈选局部重绘
                  </Button>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  圈选后只重画圈内区域，圈外保持原样；出图通道需为 OpenAI 兼容端点，否则会明确拒绝。
                </Text>
              </div>
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

      {/* 案例库横滚：点击填入完整描述（自由生图模式专属，结构化流程不混入通用案例） */}
      {isFree ? (
        <div style={{ marginTop: 28 }}>
          <SectionLabel>案例库（点击把完整画面描述写入输入框）</SectionLabel>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
            {CASES.map((c) => (
              <div
                key={c.key}
                role="button"
                tabIndex={0}
                onClick={() => { setPrompt(c.prompt); setPromptDirty(true); message.info(`已填入「${c.title}」画面描述，可直接生成`); }}
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
      ) : null}
        <Modal
          title="从「我的资料库」选择参考图"
          open={pickerOpen}
          onCancel={() => setPickerOpen(false)}
          footer={null}
          width={720}
        >
          {assets.length === 0 ? (
            <Empty description="还没有图片资料，先去「AI 生图」生成一张，或直接上传文件" />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, maxHeight: 420, overflowY: 'auto' }}>
              {assets.map((a) => (
                <div
                  key={a.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setRefImage({ assetId: a.id, url: fileUrl(`/api/media/assets/${a.id}/file`) });
                    setPickerOpen(false);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && setPickerOpen(false)}
                  style={{ cursor: 'pointer', border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 10, overflow: 'hidden' }}
                >
                  <img src={fileUrl(`/api/media/assets/${a.id}/file`)} alt={a.title} loading="lazy" style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                  <div style={{ padding: '6px 8px', fontSize: 12 }}>{a.title}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>

      {/* 圈选局部重绘：遮罩与原图 id 交给后端走 images/edits，圈外像素不动 */}
      {regionFor && (
        <RegionSelector
          open
          imageUrl={fileUrl(regionFor.url.split('?')[0])}
          onCancel={() => setRegionFor(null)}
          onConfirm={(sel) => void redrawRegion(sel)}
        />
      )}
    </div>
  );
}