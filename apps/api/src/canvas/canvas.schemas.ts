import { z } from 'zod';

/** 生图画幅：与 MediaService 的 IMAGE_ASPECT 一致 */
export const canvasSizeSchema = z.enum(['1536x1024', '1024x1536', '1024x1024']);

/** 背景意图：transparent / white 由 MediaService 翻译成提示词约束 */
export const canvasBackgroundSchema = z.enum(['auto', 'transparent', 'white']);

/**
 * 质量档已移除。
 *
 * 它原本是 schema 上的可选字段，注释写「仅作参数快照与前端展示」，
 * 但前端从来没传过、生图链路也从没读过 —— 收下、存进 job.params、然后什么都不影响。
 * 留一个「看起来能调画质」的参数，比没有更误导。
 */

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(60).optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(60),
});

export const createTurnSchema = z.object({
  prompt: z.string().trim().min(4).max(2000),
  /** 本轮基于哪一轮派生（分支树父）；不传则为对话线首轮 */
  parentId: z.string().uuid().optional(),
  /** 参考图资产（仅本租户 kind=image）：出图前由视觉模型反推成画面描述拼进提示词 */
  refAssetId: z.string().uuid().optional(),
  size: canvasSizeSchema.default('1536x1024'),
  fitVideo: z.boolean().optional(),
  background: canvasBackgroundSchema.optional(),
  /**
   * 局部重绘：原图资产 + 遮罩 dataURL，必须成对。
   * 遮罩约定与 OpenAI 一致：**要重绘的区域透明、其余不透明**。
   * 不传就是普通重出图；传了但 provider 不支持会在出图阶段明确失败而不是静默整张重画。
   */
  imageAssetId: z.string().uuid().optional(),
  maskDataUrl: z.string().max(2_000_000).optional(),
});

export const updateTurnSchema = z.object({
  prompt: z.string().trim().min(4).max(2000),
});

export type CreateConversationDto = z.infer<typeof createConversationSchema>;
export type UpdateConversationDto = z.infer<typeof updateConversationSchema>;
export type CreateTurnDto = z.infer<typeof createTurnSchema>;
export type UpdateTurnDto = z.infer<typeof updateTurnSchema>;
