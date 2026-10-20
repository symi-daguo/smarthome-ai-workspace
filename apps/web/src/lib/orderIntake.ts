import { INTAKE_SCENE_OPTIONS } from '../data/imageScenes.js';
/**
 * 接单「边聊边记」结构化采集的枚举定义（2026-10-13）
 *
 * 与后端 `apps/api/src/orders/orders.schemas.ts` 的 RENO_STAGES / SCENE_KEYS /
 * SYSTEM_KEYS **必须逐项对齐**：后端是 zod 枚举 + 白名单过滤，写库前会拒绝字典外的值。
 * 改一处必须同时改另一处，并由 smoke 的「字典外 key 被拒」断言守住。
 *
 * 为什么要有这些：接待表单里这 10 个场景与 9 类系统的三态是「智能方案」与
 * 「智能报价」能拿到结构化输入的前提。此前只有自由文本，方案与报价只能猜。
 */

/** 装修阶段：6 项 */
export const RENO_STAGES = [
  { value: 'undecided', label: '尚未开始' },
  { value: 'designing', label: '设计中' },
  { value: 'waterBefore', label: '水电施工前' },
  { value: 'waterDuring', label: '水电施工中' },
  { value: 'roughDone', label: '硬装完成' },
  { value: 'living', label: '已经入住' },
] as const;

export type RenoStageKey = (typeof RENO_STAGES)[number]['value'];

export const RENO_STAGE_LABEL: Record<string, string> = Object.fromEntries(
  RENO_STAGES.map((s) => [s.value, s.label]),
);

/** 客户想体验的场景：10 个。与生图场景预设同源（data/imageScenes.ts），
 *  key 必须逐项对齐后端 zod 白名单 SCENE_KEYS —— 写库前会拒绝字典外的值。 */
export const SCENES = INTAKE_SCENE_OPTIONS as readonly { value: string; label: string }[];

export type SceneKey = (typeof SCENES)[number]['value'];

/** 系统范围：9 类，每类三态（是否需要 / 应用区域 / 具体配置） */
export const SYSTEMS = [
  { value: 'lighting', label: '智能灯光' },
  { value: 'switch', label: '智能开关' },
  { value: 'curtain', label: '电动窗帘' },
  { value: 'wifi', label: '全屋 WiFi' },
  { value: 'automation', label: '感应自动化' },
  { value: 'security', label: '家庭安防' },
  { value: 'hvac', label: '空调与环境' },
  { value: 'voice', label: '语音控制' },
  { value: 'media', label: '影音娱乐' },
] as const;

export type SystemKey = (typeof SYSTEMS)[number]['value'];

export type NeedState = 'yes' | 'no' | 'maybe';

export const NEED_OPTIONS: { value: NeedState; label: string; color: string }[] = [
  { value: 'yes', label: '需要', color: 'green' },
  { value: 'maybe', label: '待定', color: 'orange' },
  { value: 'no', label: '不需要', color: 'default' },
];

export interface SystemEntry {
  need: NeedState;
  area: string;
  detail: string;
}

export type SystemsMap = Partial<Record<SystemKey, SystemEntry>>;

export const EMPTY_SYSTEM: SystemEntry = { need: 'maybe', area: '', detail: '' };

/** 详情页把系统三态渲染成一行摘要（列表与只读 Descriptions 共用） */
export function systemSummary(systems: unknown): { yes: string[]; maybe: string[] } {
  const yes: string[] = [];
  const maybe: string[] = [];
  if (!systems || typeof systems !== 'object' || Array.isArray(systems)) return { yes, maybe };
  for (const [key, raw] of Object.entries(systems as Record<string, unknown>)) {
    const label = SYSTEMS.find((s) => s.value === key)?.label ?? key;
    const need = (raw as { need?: string } | null)?.need;
    if (need === 'yes') yes.push(label);
    else if (need === 'maybe') maybe.push(label);
  }
  return { yes, maybe };
}

/** 详情页把场景 key 渲染成标签 */
export function sceneLabels(scenes: unknown): string[] {
  if (!Array.isArray(scenes)) return [];
  return scenes
    .map((s) => SCENES.find((x) => x.value === s)?.label ?? String(s))
    .filter(Boolean);
}
