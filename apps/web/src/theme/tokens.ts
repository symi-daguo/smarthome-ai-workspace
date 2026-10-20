/**
 * 设计 token
 *
 * 定位：信息架构与可用性遵循行业通行做法，但**视觉语言独立**——
 * 主色取更深的靛蓝（#4F46E5），点缀色引入青绿以贴合智能家居/科技调性，
 * 转角与阴影自成一套。这样开源出去一眼能看出是「我们的产品」，而不是换了皮。
 *
 * 规约：品牌渐变仅用于主按钮/强调元素；卡片背景一律纯色，禁止渐变（AGENTS.md 规约）。
 */

/** 主色渐变：靛蓝 → 紫罗兰，更沉、更冷 */
export const BRAND_GRADIENT = 'linear-gradient(135deg, #4F46E5 0%, #6D3BEF 100%)';

/** 点缀色：智能场景/在线状态等需要「区别于主色」的强调场合 */
export const ACCENT_TEAL = '#0FB5A5';
export const ACCENT_TEAL_BG = '#E6F9F6';

/** 正文墨色：比纯黑柔和，长文阅读更舒适 */
export const INK_BLACK = '#1C1B2E';

/** 统一卡片阴影（两级：常态悬浮 / 强调） */
export const CARD_SHADOW = '0 1px 2px rgba(28, 27, 46, .04), 0 4px 16px rgba(28, 27, 46, .06)';
export const CARD_SHADOW_HOVER = '0 2px 6px rgba(28, 27, 46, .06), 0 10px 28px rgba(28, 27, 46, .10)';

/** 全站内容区统一流式布局：卡片随视口等比拉宽（768 收缩 → 4K 2560+ 铺满），
 * 不设固定封顶留白；两侧弹性 padding 保证极端超宽下正文行长可读。
 * 页面内表单/步骤条等窄元素自行限制 maxWidth，卡片/表格/网格一律铺满。
 *
 * 这里**刻意不加** `minHeight` / `display:flex`：试过，全局加 flex column 后
 * 各页面根节点默认 `flex-shrink: 1`，在 minHeight 约束下被压缩，
 * 实测报价页产品库被压成空壳（标题在、产品全没了）。撑满视口高度是
 * 少数页面（对话流型页面）的需求，由那些页面自己处理，不在全局兜。
 */
export const FLUID_PADDING_X = 'clamp(12px, 2.5vw, 64px)';
export const pageContainerStyle = {
  width: '100%',
  margin: '0 auto',
  paddingBottom: 24,
} as const;

/**
 * 对话流型页面的撑高容器（AI 画布这类「左侧消息流 + 右侧参数区」布局）。
 *
 * 只给需要撑满视口高度的页面用，不放进 pageContainerStyle —— 试过全局加，
 * 各页面根节点被 flex-shrink 压缩，报价页产品库直接被压成空壳。
 *
 * minHeight 减去 Header(64) + 页面上下留白，确保卡片底边落在视口内，
 * 不会像之前那样「内容只占顶部一条、下方全是空页面底色」。
 */
export const fillHeightContainerStyle = {
  ...pageContainerStyle,
  minHeight: 'calc(100vh - 64px)',
  display: 'flex',
  flexDirection: 'column',
} as const;