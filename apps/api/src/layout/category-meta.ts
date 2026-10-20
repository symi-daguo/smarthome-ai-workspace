import { LEGACY_CATEGORY_ALIAS, PRESET_CATEGORIES } from './category-defs.js';

/**
 * 品类中文标签兜底表（AI 生成文案/生图提示词、以及 CategoryDef 未命中时使用）：
 * 由预置清单派生，security 归并到 camera，与前端 pointOverlay.CATEGORY_META 同口径。
 */
export const CATEGORY_META: Record<string, { label: string }> = Object.fromEntries(
  PRESET_CATEGORIES.map((c) => [c.key, { label: c.label }]),
);
CATEGORY_META.security = { label: '安防监控' };

/** 旧 key 归一化（security -> camera），用于品类推断与存量数据兼容 */
