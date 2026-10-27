/** 11 套方案视觉风格主题（工作台与分享页共用），色值为自有设计 */
export interface PlanTheme {
  key: string;
  name: string;
  desc: string;
  /** 页面底色 */
  bg: string;
  /** 卡片/内容底色 */
  surface: string;
  /** 主文字 */
  text: string;
  /** 次级文字 */
  sub: string;
  /** 强调色 */
  accent: string;
  /** 封面渐变 */
  cover: string;
  dark: boolean;
  /** 封面实景配图（本地 public/images） */
  coverImg: string;
}

export const PLAN_THEMES: PlanTheme[] = [
  { key: 'A', name: '暖咖咨询', desc: '奶咖暖米底，温暖好沟通', bg: '#F5EFE8', surface: '#FFFDFB', text: '#3A2E26', sub: '#8A786A', accent: '#B07A4A', cover: 'linear-gradient(135deg,#6E4B33,#B07A4A)', dark: false, coverImg: '/images/cases/c1.jpg' },
  { key: 'B', name: '极简莫兰迪', desc: '奶白低饱和，留白克制', bg: '#F1F0ED', surface: '#FFFFFF', text: '#3D3C38', sub: '#8C8A84', accent: '#9A958B', cover: 'linear-gradient(135deg,#8E8B84,#C9C5BC)', dark: false, coverImg: '/images/cases/c5.jpg' },
  { key: 'C', name: '轻奢暗金', desc: '深咖金线，浓郁格调', bg: '#241B16', surface: '#2E241E', text: '#EFE6D8', sub: '#A79680', accent: '#C9A15E', cover: 'linear-gradient(135deg,#171009,#4A3A22)', dark: true, coverImg: '/images/cases/c2.jpg' },
  { key: 'D', name: '原木侘寂', desc: '暖原木棉麻，温润自然', bg: '#F2EDE4', surface: '#FBF8F3', text: '#453B2E', sub: '#8F8271', accent: '#A08462', cover: 'linear-gradient(135deg,#7A6248,#B29A7C)', dark: false, coverImg: '/images/cases/c3.jpg' },
  { key: 'E', name: '黑白高对比', desc: '杂志编辑感，现代都市', bg: '#F4F4F4', surface: '#FFFFFF', text: '#161616', sub: '#6E6E6E', accent: '#161616', cover: 'linear-gradient(135deg,#0C0C0C,#3A3A3A)', dark: false, coverImg: '/images/cases/c1.jpg' },
  { key: 'F', name: '新中式雅韵', desc: '靛蓝暖白，留白写意', bg: '#EDF0F3', surface: '#FBFCFD', text: '#283446', sub: '#74808F', accent: '#3E5C76', cover: 'linear-gradient(135deg,#25384E,#5E7A96)', dark: false, coverImg: '/images/cases/c5.jpg' },
  { key: 'G', name: '奶油法式', desc: '奶油色系，柔和浪漫', bg: '#F7F1EA', surface: '#FFFDFA', text: '#4C4038', sub: '#9A8A7C', accent: '#C99E8A', cover: 'linear-gradient(135deg,#B98E7A,#E3C4B4)', dark: false, coverImg: '/images/cases/c4.jpg' },
  { key: 'H', name: '意式灰调', desc: '高级灰，理性质感', bg: '#ECEDEF', surface: '#FAFAFB', text: '#2C2F33', sub: '#7C828A', accent: '#5B6470', cover: 'linear-gradient(135deg,#42474E,#7C848E)', dark: false, coverImg: '/images/cases/c2.jpg' },
  { key: 'I', name: '深空科技', desc: '深色底+冷光，科技氛围', bg: '#10151F', surface: '#171E2B', text: '#E6ECF5', sub: '#8493A8', accent: '#4FA8E0', cover: 'linear-gradient(135deg,#0A1020,#1E3A5C)', dark: true, coverImg: '/images/cases/c2.jpg' },
  { key: 'J', name: '祖母绿', desc: '复古绿金，沉稳贵气', bg: '#EAF0EB', surface: '#FBFDFB', text: '#1F3A2D', sub: '#6E8577', accent: '#2E6B4F', cover: 'linear-gradient(135deg,#1C4A35,#3E7D5C)', dark: false, coverImg: '/images/cases/c3.jpg' },
  { key: 'K', name: '手绘水彩', desc: '手绘线条，亲和提案感', bg: '#F4F1F6', surface: '#FDFCFE', text: '#41394B', sub: '#8B8296', accent: '#7E6C93', cover: 'linear-gradient(135deg,#6B5A80,#A99AC0)', dark: false, coverImg: '/images/cases/c4.jpg' },
];

export function planTheme(styleKey: string): PlanTheme {
  return PLAN_THEMES.find((t) => t.key === styleKey) ?? PLAN_THEMES[0];
}

export interface PlanPage {
  type: 'cover' | 'brand' | 'layout' | 'needs' | 'ecosystem' | 'scene' | 'budget' | 'delivery' | 'floorplan' | 'quote';
  heading: string;
  subtitle: string;
  body: string;
  bullets: string[];
  /** 本页讲解稿（销售当面讲解用，客户阅读模式不显示） */
  narration: string;
  /** 底部引言块（一页一句价值收束语） */
  quote?: string;
}

export const PAGE_TYPE_LABEL: Record<PlanPage['type'], string> = {
  cover: '封面页',
  brand: '品牌与服务实力',
  layout: '空间动线与智能规划',
  needs: '家庭需求洞察',
  ecosystem: '全屋智能生态规划',
  scene: '核心场景拆解',
  budget: '预算规划与性价比方案',
  delivery: '落地交付与售后闭环',
  floorplan: '户型与设备点位',
  quote: '设备清单与报价',
};

/**
 * 页型→实景配图（本地 public/images/cases，按空间语义映射）：
 * c1 客厅落地窗灯带 / c2 家庭影院 / c3 玄关走廊感应灯 / c4 夜间卧室 / c5 餐厅暖光吊灯
 *
 * **键集 = 「可配置页型」的唯一来源**：
 * `pages/PageImages.tsx` 的 `PAGE_TYPES = Object.keys(PAGE_IMAGE)` 直接由它派生，
 * 所以增删这里的键就等于增删「页型配图」界面上的可配页型。
 *
 * 为什么没有 `floorplan`（户型与设备点位）：
 * 户型页的主体图**就是客户自己的户型图** —— 这一页存在的前提就是客户传了户型图，
 * 门店再配的任何图都没有落位。留一个勾了不显示的开关，比没有更误导用户
 * （勾了却看不到，门店只会以为系统坏了）。
 * 户型页有需要展示的实景时，由门店上传的素材本身承担。
 */
export const PAGE_IMAGE: Partial<Record<PlanPage['type'], string>> = {
  // 报价页是表格式页面，配图作页眉横幅用
  quote: '/images/cases/c5.jpg',
  cover: '/images/cases/c1.jpg',
  brand: '/images/cases/c5.jpg',
  layout: '/images/cases/c3.jpg',
  needs: '/images/cases/c5.jpg',
  ecosystem: '/images/cases/c2.jpg',
  scene: '/images/cases/c2.jpg',
  budget: '/images/cases/c5.jpg',
  delivery: '/images/cases/c1.jpg',
};

/** 场景页按副标题关键词细化配图（c4 夜间卧室过暗不可作背景，起夜/卧室场景改用 c3 感应灯暖光带） */
export function sceneImage(subtitle: string): string {
  const s = subtitle + '';
  if (s.includes('影院') || s.includes('观影') || s.includes('客厅')) return '/images/cases/c2.jpg';
  if (s.includes('卧室') || s.includes('睡眠') || s.includes('起夜') || s.includes('卫生间')) return '/images/cases/c3.jpg';
  if (s.includes('餐') || s.includes('厨')) return '/images/cases/c5.jpg';
  if (s.includes('玄关') || s.includes('归家') || s.includes('动线')) return '/images/cases/c3.jpg';
  return '/images/cases/c1.jpg';
}

/**
 * 页型配图覆盖表（运行时可写）。
 *
 * 背景：PPT 每一页的配图原本是**按页型写死的本地图片**（PAGE_IMAGE），
 * 门店换不了自己的案例图 —— 导出的方案里永远是那几张通用实景图。
 * 现在门店可以上传自己的图并指定给某个页型，导出时优先用门店的。
 *
 * 为什么用覆盖表而不是直接改 PAGE_IMAGE 常量：
 * PAGE_IMAGE 是模块级常量，改它等于把**全局状态**变成租户配置 ——
 * A 门店配完图后切到 B 门店，A 的图还留在内存里，导出时串图。
 * 覆盖表只存「当前租户配过的页型」，登录切换后重新拉一次就覆盖掉了。
 *
 * 为什么查不到就回落常量：
 * 没配过配图的部署必须与改动前**完全一致** —— 覆盖表为空时，
 * 取图结果逐字等于 PAGE_IMAGE（这是「没配 = 行为不变」的保证）。
 */
const pageImageOverrides = new Map<PlanPage['type'], string>();

/**
 * 写入覆盖表（整表替换）。
 *
 * 只接受**合法页型**（`PAGE_TYPE_LABEL` 的键 = `PlanPage['type']` 全集）：
 * 服务端可能留着历史页型（或手写的脏数据），那些键不该进覆盖表 ——
 * 否则前端会拿着一个不认识的页型去查图。
 *
 * 注意判据是「合法页型」而不是「PAGE_IMAGE 的键」：
 * `floorplan` 已从 PAGE_IMAGE 移除（户型页没有配图落点），
 * 但服务端可能早就存过一条 floorplan 配图 —— 读回来时不能因此报错，
 * 留着它也不影响：户型页的主体图是客户自己的户型图，配图不会被画上去。
 */
export function setPageImageOverrides(map: Record<string, string | undefined>): void {
  pageImageOverrides.clear();
  for (const [pageType, url] of Object.entries(map ?? {})) {
    if (!url) continue;
    if (!Object.prototype.hasOwnProperty.call(PAGE_TYPE_LABEL, pageType)) continue;
    pageImageOverrides.set(pageType as PlanPage['type'], url);
  }
}

/** 清空覆盖表（全部页型回到兜底图） */
export function clearPageImageOverrides(): void {
  pageImageOverrides.clear();
}

/**
 * 取某一页的配图：先查覆盖表，查不到再回落写死的常量。
 *
 * 场景页原本按副标题关键词细化配图（sceneImage）；
 * 门店给「场景拆解」页配了图就一律用门店自己的，不再按关键词挑。
 *
 * **不在 PAGE_IMAGE 里的页型返回空串**（不抛错）：
 * `floorplan`（户型与设备点位）没有配图落点 —— 它的主体图是客户自己的户型图。
 * 这里返回空串，调用方（预览 / 导出）就不会去画一张永远轮不到的图。
 */
export function resolvePageImage(page: PlanPage): string {
  const override = pageImageOverrides.get(page.type);
  if (override) return override;
  if (page.type === 'scene') return sceneImage(page.subtitle + page.heading);
  return PAGE_IMAGE[page.type] ?? '';
}

/** 卡片阴影（预览端 CSS；PPTX 端用 pptxgenjs shadow 对象） */
export const CARD_SHADOW = '0 6px 18px rgba(30, 22, 14, 0.10), 0 1px 3px rgba(30, 22, 14, 0.06)';
export const CARD_SHADOW_SOFT = '0 3px 10px rgba(30, 22, 14, 0.07)';

/** c4 为夜间极暗图，作背景需强提亮；其余图片亮度正常 */
export function imgFilter(src: string): string {
  return src.includes('/c4.') ? 'brightness(2.05) contrast(1.12) saturate(1.15)' : 'brightness(1.06) saturate(1.05)';
}

/** c4 灯光集中在画面右下，取景靠右下避免死黑区 */
export function imgPosition(src: string): string {
  return src.includes('/c4.') ? 'right bottom' : 'center';
}

/** 竖幅面板用 c4 时放大裁取右下角灯光区 */
export function imgSize(src: string, portrait: boolean): string {
  return src.includes('/c4.') && portrait ? 'auto 170%' : 'cover';
}
