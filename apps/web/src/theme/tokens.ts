/**
 * 设计 token（对标同类智能家居 AI 平台实测样式，见 replica/recon.md 末节）
 * 品牌渐变仅用于主按钮/强调元素；卡片背景一律纯色，禁止渐变（AGENTS.md 规约）
 */
import type { CSSProperties } from 'react';

export const BRAND_GRADIENT = 'linear-gradient(135deg, #5B5BF0 0%, #8E7BF6 100%)';
export const BRAND_GRADIENT_DEEP = 'linear-gradient(135deg, #5B5BF0 0%, #6E6EF6 100%)';
export const ACCENT_TEAL = '#4DD4D4';
export const INK_BLACK = '#191919';

/** 黑色胶囊/圆形主操作按钮（发送/登录/生成/充值） */
export const BLACK_PILL_STYLE: CSSProperties = {
  background: INK_BLACK,
  color: '#ffffff',
  border: `1px solid ${INK_BLACK}`,
  borderRadius: 9999,
  fontWeight: 700,
  boxShadow: 'none',
};
