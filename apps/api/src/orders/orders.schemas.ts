import { z } from 'zod';

/**
 * 接单「边聊边记」结构化采集（2026-10-13 补齐）
 *
 * 背景：接待表单是逐项手工采集的大表单，其中「客户想体验哪些场景」10 个开关、
 * 「系统范围」9 类系统 × (是否需要 / 应用区域 / 具体配置) 三态、预算上下限与包含范围
 * 是下游「智能方案」与「智能报价」能拿到结构化输入的前提。此前只做了 8 个自由文本字段，
 * 这部分全部缺失，导致方案页与报价页只能靠一段 needs 自由文本兜底。
 */

/** 装修阶段：6 项下拉 */
export const RENO_STAGES = ['undecided', 'designing', 'waterBefore', 'waterDuring', 'roughDone', 'living'] as const;
export type RenoStage = (typeof RENO_STAGES)[number];

export const RENO_STAGE_LABELS: Record<RenoStage, string> = {
  undecided: '尚未开始',
  designing: '设计中',
  waterBefore: '水电施工前',
  waterDuring: '水电施工中',
  roughDone: '硬装完成',
  living: '已经入住',
};

/** 客户想体验的场景：10 个 */
export const SCENE_KEYS = [
  'party', 'movie', 'home', 'away', 'sleep',
  'nightUp', 'dinner', 'read', 'work', 'morning',
] as const;
export type SceneKey = (typeof SCENE_KEYS)[number];

export const SCENE_LABELS: Record<SceneKey, string> = {
  party: '会客模式',
  movie: '观影模式',
  home: '回家模式',
  away: '离家模式',
  sleep: '睡眠模式',
  nightUp: '夜起模式',
  dinner: '就餐模式',
  read: '阅读模式',
  work: '办公模式',
  morning: '晨起模式',
};

/** 系统范围：9 类系统 */
export const SYSTEM_KEYS = [
  'lighting', 'switch', 'curtain', 'wifi', 'automation',
  'security', 'hvac', 'voice', 'media',
] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

export const SYSTEM_LABELS: Record<SystemKey, string> = {
  lighting: '智能灯光',
  switch: '智能开关',
  curtain: '电动窗帘',
  wifi: '全屋 WiFi',
  automation: '感应自动化',
  security: '家庭安防',
  hvac: '空调与环境',
  voice: '语音控制',
  media: '影音娱乐',
};

/** 单个系统的三态：是否需要 / 应用区域 / 具体配置 */
export const systemEntrySchema = z.object({
  need: z.enum(['yes', 'no', 'maybe']),
  area: z.string().max(120).default(''),
  detail: z.string().max(240).default(''),
});

export const scenesSchema = z.array(z.enum(SCENE_KEYS)).max(SCENE_KEYS.length);

/**
 * 系统范围矩阵。
 *
 * 不能直接写 `z.record(z.enum(SYSTEM_KEYS), entry)`：zod4 会把 enum key 当成
 * **必填全集**校验，于是「只填了灯光和窗帘」这种正常提交会被判成缺 7 个系统（实测踩到）。
 * 正确做法是 string key 收全部，再 refine 一次白名单——这样既能只传部分系统，
 * 又能让字典外的 key 被拒而不是被静默剥掉。
 */
export const systemsSchema = z
  .record(z.string(), systemEntrySchema)
  .refine((v) => Object.keys(v).every((k) => (SYSTEM_KEYS as readonly string[]).includes(k)), {
    message: `未知系统，只允许：${SYSTEM_KEYS.join('/')}`,
  });

export const renoStageSchema = z.enum(RENO_STAGES);

const intakeFields = {
  customer: z.string().min(1).max(64),
  phone: z.string().max(32).optional(),
  community: z.string().max(64).optional(),
  area: z.string().max(32).optional(),
  layout: z.string().max(32).optional(),
  needs: z.string().max(2000).optional(),
  rawInput: z.string().max(4000).optional(),
  budget: z.string().max(64).optional(),
  ecosystem: z.string().max(64).optional(),
  // —— 结构化采集 ——
  renoStage: renoStageSchema.optional(),
  moveInDate: z.string().max(64).optional(),
  city: z.string().max(64).optional(),
  district: z.string().max(64).optional(),
  address: z.string().max(240).optional(),
  store: z.string().max(120).optional(),
  residents: z.string().max(240).optional(),
  priority1: z.string().max(120).optional(),
  priority2: z.string().max(120).optional(),
  priority3: z.string().max(120).optional(),
  exclusions: z.string().max(500).optional(),
  habits: z.string().max(500).optional(),
  nightHabits: z.string().max(500).optional(),
  devicePrefs: z.string().max(500).optional(),
  scenes: scenesSchema.optional(),
  systems: systemsSchema.optional(),
  budgetMin: z.number().int().min(0).max(100_000_000).optional(),
  budgetMax: z.number().int().min(0).max(100_000_000).optional(),
  budgetScope: z.string().max(240).optional(),
};

/**
 * 预算上下限自洽：两个都填时上限不能小于理想起点；只填其一允许
 * （销售常只知道上限，或只有理想值）。
 *
 * 注意 zod4 不允许对含 refinement 的 schema 调 `.partial()`，
 * 所以 refine 挂在派生结果上，base 保持纯净才能派生出 update。
 */
const budgetCoherent = (v: { budgetMin?: number; budgetMax?: number }): boolean =>
  !v.budgetMin || !v.budgetMax || v.budgetMax >= v.budgetMin;

const baseOrderSchema = z.object(intakeFields);

export const createOrderSchema = baseOrderSchema.refine(budgetCoherent, {
  message: '客户预算上限不能小于理想预算起点',
  path: ['budgetMax'],
});

export const updateOrderSchema = baseOrderSchema.partial().refine(budgetCoherent, {
  message: '客户预算上限不能小于理想预算起点',
  path: ['budgetMax'],
});

export const orderStatusSchema = z.object({
  status: z.enum(['new', 'qualified', 'proposed', 'quoted', 'won', 'lost']),
  lostReason: z.string().max(200).optional(),
  planId: z.string().uuid().optional(),
});

export const addNoteSchema = z.object({
  content: z.string().min(1).max(2000),
});

export const intakeSchema = z.object({
  rawInput: z.string().min(10).max(4000),
  /** 幂等键：弱网重试不该重复扣额度（可选，不传则保持原行为） */
  clientRequestId: z.string().max(80).optional(),
});

/** 跟进建议入参：只带幂等键，无其他字段 */
export const followupSchema = z.object({
  clientRequestId: z.string().max(80).optional(),
});
export type FollowupDto = z.infer<typeof followupSchema>;

export type CreateOrderDto = z.infer<typeof createOrderSchema>;
export type UpdateOrderDto = z.infer<typeof updateOrderSchema>;
export type OrderStatusDto = z.infer<typeof orderStatusSchema>;
export type AddNoteDto = z.infer<typeof addNoteSchema>;
export type IntakeDto = z.infer<typeof intakeSchema>;
export type SystemsMap = z.infer<typeof systemsSchema>;
