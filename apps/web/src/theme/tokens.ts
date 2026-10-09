/**
 * 设计 token（对标同类智能家居 AI 平台实测样式，见 replica/recon.md 末节）
 * 品牌渐变仅用于主按钮/强调元素；卡片背景一律纯色，禁止渐变（AGENTS.md 规约）
 */
export const BRAND_GRADIENT = 'linear-gradient(135deg, #5B5BF0 0%, #8E7BF6 100%)';
export const INK_BLACK = '#191919';

/**
 * 全站内容区统一流式布局：卡片随视口等比拉宽（768 收缩 → 4K 2560+ 铺满），
 * 不设固定封顶留白；两侧弹性 padding 保证极端超宽下正文行长可读。
 * 页面内表单/步骤条等窄元素自行限制 maxWidth，卡片/表格/网格一律铺满。
 */
export const FLUID_PADDING_X = 'clamp(12px, 2.5vw, 64px)';
export const pageContainerStyle = {
  width: '100%',
  margin: '0 auto',
  paddingBottom: 24,
} as const;
