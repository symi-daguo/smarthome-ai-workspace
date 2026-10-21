import { z } from 'zod';

/** 对标账号：用户配置「我们盯谁」 */
export const createAccountSchema = z.object({
  /** 平台标识：用户自填自由文本，不在代码里枚举具体平台 */
  platform: z.string().trim().min(1, '请填写平台').max(30),
  /** 账号名（展示用） */
  accountName: z.string().trim().min(1, '请填写账号名').max(60),
  /** 账号主页链接：采集端据此定位账号 */
  homeUrl: z.string().trim().min(4, '请填写主页链接').max(300),
  /** 分组标签，逗号分隔 */
  tags: z.string().trim().max(200).default(''),
  /** 备注：这个账号为什么值得对标 */
  note: z.string().trim().max(500).default(''),
  /** 停用后不参与采集与分析 */
  enabled: z.boolean().default(true),
});
export type CreateAccountDto = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = createAccountSchema.partial();
export type UpdateAccountDto = z.infer<typeof updateAccountSchema>;

const statField = z.number().int().min(0).max(1_000_000_000);

/**
 * 采集结果提交：Agent 采回来的内容元数据。
 *
 * items 里每一项对应一条内容。accountId 必须是本租户已配置的对标账号，
 * 否则整批拒绝——防止把别的租户或随手编的账号塞进来。
 */
export const submitContentsSchema = z.object({
  /** 采集批次号：同一次采集归一批，便于溯源与重跑 */
  batchId: z.string().trim().max(80).optional(),
  items: z
    .array(
      z.object({
        accountId: z.string().uuid('缺少对标账号 id'),
        title: z.string().trim().min(1, '内容标题不能为空').max(200),
        text: z.string().trim().min(1, '正文文案不能为空').max(4000),
        sourceUrl: z.string().trim().min(1, '内容链接不能为空').max(500),
        publishedAt: z.string().trim().max(60).optional(),
        play: statField.optional(),
        like: statField.optional(),
        comment: statField.optional(),
        collect: statField.optional(),
        share: statField.optional(),
        topics: z.array(z.string().trim().max(50)).max(30).optional(),
        coverUrl: z.string().trim().max(500).optional(),
        durationSec: z.number().int().min(0).max(36000).optional(),
      }),
    )
    .min(1, '没有可提交的内容')
    .max(500, '单次最多提交 500 条'),
});
export type SubmitContentsDto = z.infer<typeof submitContentsSchema>;

/**
 * 触发映射分析。
 *
 * 不给 accountId = 分析全部启用账号；给了 = 只分析这一个。
 * topN = 每个账号取多少条热门内容作为分析样本。
 */
export const analyzeSchema = z.object({
  accountId: z.string().uuid().optional(),
  topN: z.number().int().min(5, '至少 5 条').max(100, '最多 100 条').default(30),
});
export type AnalyzeDto = z.infer<typeof analyzeSchema>;
