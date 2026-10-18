/**
 * 生图智能场景预设 —— 单一数据源（2026-10-18）。
 *
 * 此前散在三处、且各缺一半：
 * - `ImageStudio.tsx` 里 `SCENES` + `SCENE_PROMPTS` 有 18 个，只服务于「自由生图」的 chip
 * - `imageWorkflows.ts` 的毛坯房工作流声明了「叠加智能灯光场景（最多 3 个）」，
 *   但 `options: []` 是**空的** —— 界面上让用户去选，一个选项都没有
 * - `orderIntake.ts` 的接单勾选列表另有 10 个，只有 label 没有提示词
 *
 * 合并到这一份。生图两处共用同一批预设，接单则取其中带 `intakeKey` 的那些。
 *
 * `intakeKey` 必须与后端 `orders.schemas.ts` 的 `SCENE_KEYS` 逐项对齐 ——
 * 那是 zod 白名单，写库前会拒绝字典外的值，填错就是用户提交接单时吃 400。
 * 由 smoke 的「前端接单场景与后端白名单逐项对齐」断言守住。
 *
 * 「睡眠模式」是唯一的例外：它是接单需求项（客户想睡好觉），
 * 但生图场景集里没有对应画面预设，所以只出现在接单列表，不带 intakeKey。
 */

export interface ImageScenePreset {
  label: string;
  /** 完整出图描述：色温/层次/氛围 + 构图 + 摄影质感，直接进提示词 */
  prompt: string;
  /** 进智能接单勾选列表时使用的 key（须在服务端 SCENE_KEYS 内） */
  intakeKey?: string;
}

export const IMAGE_SCENES: ImageScenePreset[] = [
  {
    label: '观影模式',
    intakeKey: 'movie',
    prompt: '现代家庭影院客厅，电动窗帘缓缓关闭，壁挂电视亮起冷色画面光，主灯熄灭、吊顶灯带与地脚灯渐暗至 20% 暖光，沙发区保留柔和微光，真实室内摄影质感，电影感色调，广角镜头',
  },
  {
    label: '会客模式',
    intakeKey: 'party',
    prompt: '明亮通透的现代客厅，主灯与吊顶灯带渐亮至会客亮度 4000K 暖白光，茶几区域光线均匀，空间整洁温馨，真实室内摄影质感，平视广角',
  },
  {
    label: '就餐模式',
    intakeKey: 'dinner',
    prompt: '餐厅场景，餐桌上方三头吊灯渐亮聚焦餐桌，餐边柜灯带同步亮起，3000K 暖白色调，餐具与花艺点缀，真实室内摄影质感，浅景深',
  },
  {
    label: '起夜模式',
    intakeKey: 'nightUp',
    prompt: '深夜卧室到走廊动线，人体感应触发床底灯带与走廊地脚灯以 10% 低亮度微光照明，2700K 柔光不刺眼，地面有柔和光带，真实室内摄影质感，夜间氛围',
  },
  {
    label: '阅读模式',
    intakeKey: 'read',
    prompt: '书房/卧室阅读角，书桌台灯重点照明充足显色性好，环境光柔和无眩光，书架背景整洁，3500K 中性光，真实室内摄影质感',
  },
  {
    label: '浪漫模式',
    prompt: '卧室浪漫氛围，低色温 2200K 暖光，床头壁灯与灯带调至最柔，隐约烛光氛围，纱帘半透，暗调高级感，真实室内摄影质感',
  },
  {
    label: '派对模式',
    prompt: '客厅派对场景，RGB 彩色律动灯带沿吊顶与电视墙铺陈，紫蓝粉光影交替，活力动感氛围，烟雾光束感，真实室内摄影质感',
  },
  {
    label: '晨起模式',
    intakeKey: 'morning',
    prompt: '清晨卧室，窗帘缓缓打开透入自然光，灯光模拟日出由暖黄渐亮至冷白 5000K，唤醒氛围，床上用品整洁，真实室内摄影质感，逆光柔和',
  },
  {
    label: '工作模式',
    intakeKey: 'work',
    prompt: '居家办公场景，明亮均匀的 5000K 功能照明，书桌区域无阴影，屏幕无眩光反射，空间清爽现代，真实室内摄影质感',
  },
  {
    label: '节日模式',
    prompt: '春节/节日家庭场景，红色节日彩灯与暖白主灯交织，客厅有精致装饰挂件，喜庆而不俗气，真实室内摄影质感',
  },
  {
    label: '淡彩光',
    prompt: '客厅低饱和淡彩氛围光，墙面与吊顶有粉蓝紫柔和渐变洗墙光，现代极简家具，梦幻而高级，真实室内摄影质感',
  },
  {
    label: '归家模式',
    intakeKey: 'home',
    prompt: '入户玄关视角，开门瞬间玄关感应灯亮起，客厅灯光由近及远渐次点亮，欢迎回家的温暖动线，3000K 暖光，真实室内摄影质感',
  },
  {
    label: '离家模式',
    intakeKey: 'away',
    prompt: '全屋灯光依次关闭后的空镜，仅门廊保留一盏夜灯，窗外自然光，整洁安静的现代家居，真实室内摄影质感',
  },
  {
    label: '烹饪模式',
    prompt: '现代厨房，操作台上方高亮度显色照明，油烟机与橱柜灯带联动无暗区，不锈钢与石材质感，4000K 白光，真实室内摄影质感',
  },
  {
    label: '午休模式',
    prompt: '午后卧室，纱帘半闭透入柔和漫射光，灯光渐暗至 20%，空调面板微光，安静休憩氛围，真实室内摄影质感',
  },
  {
    label: '健身模式',
    prompt: '家庭健身角，明亮 5000K 白光均匀照明，镜面墙与运动器材，动感节奏氛围，干净利落，真实室内摄影质感',
  },
  {
    label: '电竞模式',
    prompt: '电竞房，桌面与背景墙蓝紫色 RGB 氛围光，双显示器冷光，灯带控制屏幕反光，赛博朋克氛围，真实室内摄影质感',
  },
];

/** 自由生图 chip 的展示顺序（与场景列表一致） */
export const IMAGE_SCENE_LABELS = IMAGE_SCENES.map((s) => s.label);

/** label → 提示词，供自由生图 chip 点击填入 */
export const IMAGE_SCENE_PROMPTS: Record<string, string> = Object.fromEntries(
  IMAGE_SCENES.map((s) => [s.label, s.prompt]),
);

/** 工作流 optionGroups 用的形态（value 用下标，兼容 WorkflowOption 结构） */
export const IMAGE_SCENE_OPTIONS = IMAGE_SCENES.map((s, i) => ({
  value: `scene_${i}`,
  label: s.label,
  prompt: s.prompt,
}));

/** 智能接单勾选列表：带 intakeKey 的场景 + 仅接单存在的睡眠模式。
 *  顺序与 orderIntake.ts 原来的 SCENES 保持一致，避免界面顺序变化。 */
export const INTAKE_SCENE_OPTIONS = [
  { value: 'party', label: '会客模式' },
  { value: 'movie', label: '观影模式' },
  { value: 'home', label: '回家模式' },
  { value: 'away', label: '离家模式' },
  { value: 'sleep', label: '睡眠模式' },
  { value: 'nightUp', label: '夜起模式' },
  { value: 'dinner', label: '就餐模式' },
  { value: 'read', label: '阅读模式' },
  { value: 'work', label: '办公模式' },
  { value: 'morning', label: '晨起模式' },
];
