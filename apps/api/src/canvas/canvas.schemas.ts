import { z } from 'zod';

/** 生图画幅：与 MediaService 的 IMAGE_ASPECT 一致 */
export const canvasSizeSchema = z.enum(['1536x1024', '1024x1536', '1024x1024']);

/** 背景意图：transparent / white 由 MediaService 翻译成提示词约束 */
export const canvasBackgroundSchema = z.enum(['auto', 'transparent', 'white']);

/** 质量档：仅作参数快照与前端展示，价格口径复用 token 计费 */
export const canvasQualitySchema = z.enum(['standard', 'high']);

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
  /** 参考图资产（仅本租户 kind=image）；我方生图暂不支持图生图，仅作上下文记录 */
  refAssetId: z.string().uuid().optional(),
  size: canvasSizeSchema.default('1536x1024'),
  fitVideo: z.boolean().optional(),
  background: canvasBackgroundSchema.optional(),
  quality: canvasQualitySchema.optional(),
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
