/**
 * AI 生图业务子工作流定义（纯数据 + 纯函数，无 React 依赖）
 *
 * 后端 POST /api/media/images 的 size 是枚举，只接受 1536x1024 / 1024x1536 / 1024x1024 三种，
 * 因此每个工作流的「比例」分两层表达：
 *   - size：实际发给后端的合法像素规格（该比例最接近的可用值）
 *   - ratio：写进提示词的比例意图，模型据此安排构图，所以 3:4 / 2:3 等非枚举比例同样生效
 */

import { IMAGE_SCENE_OPTIONS } from './imageScenes.js';

export type WorkflowKey = 'free' | 'bare' | 'cover' | 'poster' | 'colorplan';

/** 单个可选项：label 展示，prompt 是选中后进入提示词的完整描述（不是半句占位） */
export interface WorkflowOption {
  value: string;
  label: string;
  prompt: string;
}

/** 单选/多选组；required 的组未选会进入「必填项未完成」清单 */
export interface OptionGroup {
  id: string;
  label: string;
  /** 灰色辅助说明，写清该组在流程里的作用 */
  hint: string;
  required: boolean;
  /** true 表示可多选，max 生效 */
  multiple?: boolean;
  max?: number;
  options: WorkflowOption[];
}

/** 自由文本字段；multiline 为 true 时按行拆成数组使用 */
export interface TextField {
  id: string;
  label: string;
  placeholder: string;
  required: boolean;
  multiline?: boolean;
  hint?: string;
}

export interface WorkflowSize {
  /** 必须是 /api/media/images 枚举内的值 */
  value: string;
  label: string;
  /** 写进提示词的比例意图 */
  ratio: string;
}

/** 封面模式：LLM 生成后可编辑的文案 */
export interface CoverCopy {
  title: string;
  tags: string[];
  sellingPoints: string[];
}

/** 工作流的结构化输入；提示词文本框始终是最终唯一事实源，本对象只负责「组装」 */
export interface WorkflowDraft {
  /** 单选组当前选中值（每种工作流只有一个必选单选组） */
  choice: string;
  /** 叠加的智能灯光场景名（沿用 ImageStudio 的 17 个场景） */
  scenes: string[];
  /** TextField 的值，键为 field.id；multiline 字段存原始多行文本 */
  text: Record<string, string>;
  /** 封面模式文案；其余模式为空结构 */
  copy: CoverCopy;
}

export interface ImageWorkflowDef {
  key: WorkflowKey;
  name: string;
  description: string;
  /** 是否必须上传参考图 */
  requiresRef: boolean;
  /** 参考图区的字段名与说明，随工作流变化 */
  refLabel: string;
  refHint: string;
  sizes: WorkflowSize[];
  /** 进入该模式时的默认尺寸 */
  defaultSize: string;
  optionGroups: OptionGroup[];
  textFields: TextField[];
  /** 单选组切换后是否自动改写尺寸（平面图比例随风格适配用） */
  sizeFollowsChoice?: boolean;
  /** 组装完整提示词；scenePrompts 由页面传入，避免在此重复定义场景文案 */
  buildPrompt: (draft: WorkflowDraft, scenePrompts: Record<string, string>, ratio: string) => string;
  /** 可选：一键生成文案的 LLM 请求；仅封面模式使用 */
  copyPrompt?: (topic: string) => { systemPrompt: string; prompt: string };
}

/** 新模式的初始草稿 */
export function emptyDraft(): WorkflowDraft {
  return { choice: '', scenes: [], text: {}, copy: { title: '', tags: [], sellingPoints: [] } };
}

/* ---------------------------------------------------------------- 方案选项 */

const DECOR_STYLES: WorkflowOption[] = [
  { value: 'modern', label: '现代简约', prompt: '去繁就简的直线条造型，浅木饰面搭配米白墙面，黑色金属细线收边，柜门按压式无把手，材质克制' },
  { value: 'cream', label: '奶油风', prompt: '奶油白与燕麦色大面积铺陈，圆形与弧线造型语言，微水泥质感墙面，柔软织物与木质摆件，暖调低对比' },
  { value: 'wabi', label: '侘寂风', prompt: '微水泥与手工抹灰墙面，色系偏灰褐，粗陶与原木器物，大面积留白，低饱和度，自然肌理' },
  { value: 'newchinese', label: '新中式', prompt: '现代骨架搭配中式语汇，深木色格栅与屏风，博古架与圈椅，黛青与朱砂点色' },
  { value: 'industrial', label: '工业风', prompt: '清水混凝土墙面与裸装管线，红砖与铁艺隔断，黑色金属轨道灯与轨道插座，深灰水泥地坪，粗犷厚重' },
  { value: 'nordic', label: '北欧风', prompt: '浅橡木、白墙与浅灰布艺，大面积自然采光，简洁线条家具，低饱和莫兰迪配色，柔软地毯' },
  { value: 'luxury', label: '轻奢', prompt: '岩板与瓷砖大面铺装，金属收边线条，香槟金与哑光黑搭配皮革与丝绒硬包，灯带勾勒轮廓，精致冷调' },
  { value: 'wood', label: '原木风', prompt: '全屋实木与木饰面，暖橡木与胡桃木交错拼搭，保留木纹肌理，自然采光，朴素温润' },
];

const PLAN_STYLES: (WorkflowOption & { size: string })[] = [
  { value: 'nordic', label: '北欧', prompt: '浅木色家具底色，白灰墙面，低饱和绿植点缀，简洁通透', size: '1536x1024' },
  { value: 'modern', label: '现代', prompt: '冷灰与深木对比，线条利落，金属细节，块面整洁', size: '1536x1024' },
  { value: 'luxury', label: '轻奢', prompt: '米金与深咖配色，弧形家具与皮革材质，精致软装', size: '1024x1024' },
  { value: 'industrial', label: '工业', prompt: '水泥灰与铁锈色，金属与皮质家具，粗放的结构感', size: '1024x1024' },
  { value: 'retro', label: '中古', prompt: '焦糖橙与墨绿，胡桃木与藤编，复古造型与暖黄灯光', size: '1536x1024' },
];

const FESTIVALS: WorkflowOption[] = [
  { value: 'spring', label: '春节', prompt: '主色：中国红配鎏金，大面积正红背景与金色祥云纹，灯笼、剪纸、鞭炮与新春福字装饰，暖红光氛围，喜庆厚重' },
  { value: 'lantern', label: '元宵', prompt: '主色：绛红配金黄，圆形宫灯与元宵花灯成排悬挂，玉兔与祥云纹样，暖橙光氛围，柔和团圆感' },
  { value: 'valentine', label: '情人节', prompt: '主色：玫瑰红与奶白，玫瑰花束与爱心元素，烛光氛围，粉调柔光，浪漫克制不艳俗' },
  { value: 'women', label: '妇女节', prompt: '主色：香槟粉与暖白，优雅花卉与丝带元素，明亮通透的浅色调，柔光氛围，精致大方' },
  { value: 'labor', label: '劳动节', prompt: '主色：靛蓝与活力橙，劳动者剪影与齿轮麦穗元素，明快高饱和配色，硬朗阳光氛围' },
  { value: 'dragon', label: '端午', prompt: '主色：艾草绿与粽叶青，龙舟与粽子、五色绳、香囊元素，清新自然配色，凉爽通透氛围' },
  { value: 'midautumn', label: '中秋', prompt: '主色：深靛蓝配鎏金金黄，满月与玉兔桂花云纹，团圆意象，暖金月光氛围，沉静雅致' },
  { value: 'national', label: '国庆', prompt: '主色：中国红配金黄，天安门与长城、烟花红旗元素，庄重喜庆，明亮有纪念感' },
  { value: 'double11', label: '双十一', prompt: '主色：深空灰配荧光橙红，电商大促标签与数字元素，强对比撞色，光效锐利，科技感强' },
  { value: 'double12', label: '双旦', prompt: '主色：圣诞红与常青绿，雪花彩带与松枝元素，暖黄灯串，金红点缀，节日暖光氛围' },
  { value: 'christmas', label: '圣诞', prompt: '主色：深红与雪白，常青松树与彩灯，壁炉与礼物元素，暖黄烛光氛围，安静温暖' },
  { value: 'anniversary', label: '周年庆', prompt: '主色：品牌金与深空黑，数字年轮与丝带元素，庆典光束与粒子，隆重高端质感' },
];

/* ---------------------------------------------------------------- 尺寸选项 */

const SIZE_LANDSCAPE = '1536x1024';
const SIZE_PORTRAIT = '1024x1536';
const SIZE_SQUARE = '1024x1024';

/** 固定比例：选项只有一个，页面会禁用下拉 */
const FIXED_SIZES = (value: string, label: string, ratio: string): WorkflowSize[] => [{ value, label, ratio }];

const BARE_SIZES: WorkflowSize[] = [
  { value: SIZE_LANDSCAPE, label: '横版 4:3（1536×1024）', ratio: '4:3 横构图' },
  { value: SIZE_PORTRAIT, label: '竖版 3:4（1024×1536）', ratio: '3:4 竖构图' },
  { value: SIZE_SQUARE, label: '方版 1:1（1024×1024）', ratio: '1:1 方构图' },
];

const PLAN_SIZES: WorkflowSize[] = [
  { value: SIZE_LANDSCAPE, label: '横版（1536×1024）', ratio: '横版图纸' },
  { value: SIZE_SQUARE, label: '方版（1024×1024）', ratio: '1:1 方版图纸' },
  { value: SIZE_PORTRAIT, label: '竖版（1024×1536）', ratio: '竖版图纸' },
];

/* ---------------------------------------------------------------- 内部工具 */

/** 取单选组当前选中项的描述 */
function pick(options: WorkflowOption[], value: string): string {
  return options.find((o) => o.value === value)?.prompt ?? '';
}

/** 场景名列表 -> 「场景名：描述」串联片段 */
function sceneClause(scenes: string[], scenePrompts: Record<string, string>): string {
  return scenes
    .filter((s) => scenePrompts[s])
    .map((s) => `${s}（${scenePrompts[s]}）`)
    .join('；');
}

/** 去掉标签里的序号前缀与括号补充，只留字段名，用在必填提示里 */
function fieldName(label: string): string {
  return label
    .replace(/^[①-⑨]\s*/, '')
    .replace(/（.*$/, '')
    .trim();
}

/* ---------------------------------------------------------------- 定义 */

export const IMAGE_WORKFLOWS: ImageWorkflowDef[] = [
  {
    key: 'free',
    name: '自由生图',
    description: '自己写描述或点场景自动填入，任意题材都能出图',
    requiresRef: false,
    refLabel: '参考图（可选）：上传客户现场图，一键反推同风格提示词',
    refHint: '由视觉模型读出风格/色调/构图，自动写入下方描述',
    sizes: [
      { value: SIZE_LANDSCAPE, label: '横图 1536x1024', ratio: '' },
      { value: SIZE_PORTRAIT, label: '竖图 1024x1536', ratio: '' },
      { value: SIZE_SQUARE, label: '方图 1024x1024', ratio: '' },
    ],
    defaultSize: SIZE_LANDSCAPE,
    optionGroups: [],
    textFields: [],
    // 自由生图沿用页面原有的手写描述，不做结构化组装
    buildPrompt: () => '',
  },
  {
    key: 'bare',
    name: '毛坯房效果图',
    description: '传毛坯房照片 + 选装修风格，户型结构一字不改，直接看装修后的样子',
    requiresRef: true,
    refLabel: '毛坯房照片（必传）',
    refHint: '上传未装修的现场照片，户型与门窗位置会被严格保留',
    sizes: BARE_SIZES,
    defaultSize: SIZE_LANDSCAPE,
    optionGroups: [
      {
        id: 'style',
        label: '装修风格（必选，再点一次取消）',
        hint: '风格决定材质、色彩与造型语言，是这一步唯一的关键选择',
        required: true,
        options: DECOR_STYLES,
      },
      {
        id: 'scenes',
        label: '叠加智能灯光场景（可选，最多 3 个）',
        hint: '在装修底子上叠加灯光氛围，体现门店的整装能力',
        required: false,
        multiple: true,
        max: 3,
        // 此前这里是 options: [] —— 界面上写着「最多 3 个」却一个选项都没有。
        // 预设抽到 data/imageScenes.ts：与自由生图的场景 chip 同源，不再两处各写一份。
        options: IMAGE_SCENE_OPTIONS,
      },
    ],
    textFields: [],
    buildPrompt: (d, scenePrompts, ratio) => {
      const scenes = sceneClause(d.scenes, scenePrompts);
      return [
        '毛坯房装修效果图，严格以参考图原始户型为底稿。',
        '硬性约束：承重墙与隔墙走向、门窗洞口位置与尺寸、阳台与飘窗结构、层高、拍摄机位与透视关系全部与原图一致，只做装修不改动空间格局，不增删墙体、不改变开口。',
        `装修风格：${pick(DECOR_STYLES, d.choice)}。`,
        scenes ? `叠加智能灯光场景：${scenes}。` : '',
        `画面比例：${ratio}。`,
        '效果自然可信：呈现装修完成后的现场照片质感，光影与材质真实，无多余文字与水印。',
      ]
        .filter(Boolean)
        .join('');
    },
  },
  {
    key: 'cover',
    name: '视频封面',
    description: '传人物照片 + 填视频主题，标题、侧边标签与卖点自动生成，竖版封面直接可用',
    requiresRef: true,
    refLabel: '人物照片（必传）',
    refHint: '上传出镜人物照，封面主体就是这张照片',
    sizes: FIXED_SIZES(SIZE_PORTRAIT, '竖版 3:4（1024×1536）', '3:4 竖版'),
    defaultSize: SIZE_PORTRAIT,
    optionGroups: [],
    textFields: [{ id: 'topic', label: '视频主题（必填）', placeholder: '例如：三室两厅全屋智能交工实拍', required: true }],
    // 文案生成的 systemPrompt 限长 1000、prompt 限长 2000（后端 zod 约束），这里都留足余量
    copyPrompt: (topic) => ({
      systemPrompt:
        '你是智能家居门店的短视频封面文案助手。只返回一个 JSON 对象，不要 markdown 代码块、不要解释。格式：{"title":"大标题","tags":["短标签"],"sellingPoints":["卖点"]}。title 为 8 字内抓眼短句；tags 为 3-4 个 4 字内标签；sellingPoints 为 3 条 10 字内卖点。全部中文，不加标点，不出现违规极限词。',
      prompt: `请为下面这个视频主题产出竖版封面文案。主题：${topic}`,
    }),
    buildPrompt: (d, _scenePrompts, ratio) => {
      const title = d.copy.title.trim();
      const tags = d.copy.tags.filter(Boolean);
      const points = d.copy.sellingPoints.filter(Boolean);
      return [
        '短视频竖版封面海报，主体为参考图中的出镜人物，保持人物面部特征、发型与姿态自然不变。',
        `视频主题：${(d.text.topic ?? '').trim()}。`,
        '版式：上部约三分之一为大标题区，中部为人物主体画面，下部留出信息区，四周保持安全边距。',
        title ? `主标题文字：「${title}」，超粗黑体，居中，字号最大，描边加投影保证在复杂背景上清晰可读。` : '',
        tags.length ? `左侧竖排标签：${tags.map((t) => `「${t}」`).join('、')}，圆角胶囊底色，深色半透明，竖向等距排列。` : '',
        points.length ? `右侧竖排卖点：${points.map((t) => `「${t}」`).join('、')}，每条前置高亮圆点，短句排列。` : '',
        '配色：以人物照片主色延展，背景压暗做渐变，文字与背景形成强对比，整体干净有设计感。',
        `画面比例：${ratio}。`,
        '文字要求：字形端正清晰、无错字变形，除上述文案外画面不出现任何多余文字与水印。',
      ]
        .filter(Boolean)
        .join('');
    },
  },
  {
    key: 'poster',
    name: '节假日海报',
    description: '选节日 + 填门店名，节日主色与智能灯光氛围一次成图，门店可直接发朋友圈',
    requiresRef: false,
    refLabel: '参考图（可选）',
    refHint: '可传门店实景或样品间照片做背景底图',
    sizes: FIXED_SIZES(SIZE_PORTRAIT, '竖版 2:3（1024×1536）', '2:3 竖版'),
    defaultSize: SIZE_PORTRAIT,
    optionGroups: [
      {
        id: 'festival',
        label: '节日（必选）',
        hint: '决定主色、装饰元素与整体气氛',
        required: true,
        options: FESTIVALS,
      },
    ],
    textFields: [
      { id: 'shopName', label: '门店名称（必填）', placeholder: '例如：光谷智能家居体验店', required: true },
      {
        id: 'shopTags',
        label: '门店特色标签（可选，一行一个）',
        placeholder: '全屋智能方案\n免费量房设计\n本地安装售后',
        required: false,
        multiline: true,
        hint: '一行一个，最多取前 5 个',
      },
    ],
    buildPrompt: (d) => {
      const shop = (d.text.shopName ?? '').trim();
      const tags = (d.text.shopTags ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
      return [
        '智能家居门店节假日宣传海报，竖版构图。',
        `节日氛围：${pick(FESTIVALS, d.choice)}。`,
        shop
          ? `主标题文字：门店名称「${shop}」，横跨画面上部居中排版，超粗黑体，白色描边加金边投影，字形端正清晰无变形。`
          : '',
        tags.length ? `特色标签：${tags.map((t) => `「${t}」`).join('、')}，以小号圆角胶囊形式点缀在门店名下方，横向排列。` : '',
        '智能灯光元素：画面下方以智能家居体验空间为主体，灯带洗墙、天花无主灯、智能面板与传感器节点可见，灯光按节日主色着色，冷暖对比清晰。',
        '商业海报级排版，层次分明，元素前后关系合理，色彩通透，高清画质。',
        '画面比例 2:3 竖版。',
        '除门店名与标签文案外画面不出现其他文字与水印。',
      ]
        .filter(Boolean)
        .join('');
    },
  },
  {
    key: 'colorplan',
    name: '平面图转彩平图',
    description: '传户型平面图 + 选风格，出专业室内彩色平面布置图，比例随风格自动适配',
    requiresRef: true,
    refLabel: '户型平面图（必传）',
    refHint: '上传 CAD 截图或户型图，墙体与开门方向会被严格对齐',
    sizes: PLAN_SIZES,
    defaultSize: SIZE_LANDSCAPE,
    sizeFollowsChoice: true,
    optionGroups: [
      {
        id: 'style',
        label: '配色风格（必选）',
        hint: '风格决定图纸配色，切换风格会同步推荐更合适的输出比例',
        required: true,
        options: PLAN_STYLES.map(({ size, ...o }) => o),
      },
    ],
    textFields: [],
    buildPrompt: (d, _scenePrompts, ratio) => [
      '专业室内彩色平面布置图（color floor plan），正俯视正投影视角，无透视变形、无倾斜。',
      '结构硬约束：墙体结构与厚度、房间划分、门窗位置、开门方向与开启弧线必须与参考户型图完全一致，只做上色与家具布置，不改动原始户型，不新增隔断。',
      `配色风格：${pick(PLAN_STYLES, d.choice)}。`,
      '彩色填充：墙体与门洞为深灰实线填充，家具与图标按功能分区使用低饱和配色区分（客卧餐厨卫），家具为专业线稿俯视符号（沙发、床、餐桌、橱柜、洁具）。',
      '图纸要素：完整呈现房间名称标注、尺寸标注、指北针、比例尺与图例说明，版式留白得当。',
      `输出比例：${ratio}，需完整容纳整套房型不裁切。`,
      '高清线稿级清晰度，线条锐利，配色均匀无杂点。',
    ].join(''),
  },
];

export function getWorkflow(key: WorkflowKey): ImageWorkflowDef {
  return IMAGE_WORKFLOWS.find((w) => w.key === key) ?? IMAGE_WORKFLOWS[0];
}

/** 某工作流下单选值对应的推荐尺寸；不随风格变的工作流返回 null */
export function recommendedSize(wf: ImageWorkflowDef, choice: string): string | null {
  if (!wf.sizeFollowsChoice) return null;
  return PLAN_STYLES.find((s) => s.value === choice)?.size ?? null;
}

/**
 * 从 /api/llm/chat 的回复里取封面文案。
 * 该端点返回自由文本（不是结构化 DTO），模型可能裹 markdown 代码块或前后带解释，
 * 这里先剥壳再取最外层 JSON 对象；解析失败返回空结构，由用户手填，不阻断流程。
 */
export function parseCoverCopy(reply: string): CoverCopy {
  const bare = reply
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = bare.indexOf('{');
  const end = bare.lastIndexOf('}');
  if (start === -1 || end <= start) return emptyDraft().copy;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(bare.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return emptyDraft().copy;
  }
  // 模型可能回数组或用顿号/逗号串行，都归一成数组
  const toList = (v: unknown): string[] => {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[、,，;；]/) : [];
    return arr.map((x) => String(x).trim()).filter(Boolean);
  };
  return {
    title: typeof obj.title === 'string' ? obj.title.trim() : '',
    tags: toList(obj.tags).slice(0, 4),
    sellingPoints: toList(obj.sellingPoints).slice(0, 3),
  };
}

/** 必填项未完成清单；空数组表示可以组装/生成 */
export function missingItems(wf: ImageWorkflowDef, draft: WorkflowDraft, hasRef: boolean): string[] {
  const miss: string[] = [];
  if (wf.requiresRef && !hasRef) miss.push(fieldName(wf.refLabel));
  for (const g of wf.optionGroups) {
    if (g.required && g.id !== 'scenes' && !draft.choice) miss.push(fieldName(g.label));
  }
  for (const f of wf.textFields) {
    if (f.required && !(draft.text[f.id] ?? '').trim()) miss.push(fieldName(f.label));
  }
  if (wf.key === 'cover' && !draft.copy.title.trim()) miss.push('封面主标题');
  return miss;
}