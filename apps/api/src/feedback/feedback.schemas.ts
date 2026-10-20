import { z } from 'zod';

export const createFeedbackSchema = z.object({
  // bug（故障）| feature（需求）| other（其他）
  category: z.enum(['bug', 'feature', 'other']),
  title: z.string().min(1).max(100),
  detail: z.string().max(2000).optional(),
});

/** 处理动作：状态推进与官方回复（仅管理员） */
export const updateFeedbackSchema = z.object({
  // open（待处理）| processing（处理中）| resolved（已解决）| closed（已关闭）
  status: z.enum(['open', 'processing', 'resolved', 'closed']).optional(),
  reply: z.string().max(2000).optional(),
});

export type CreateFeedbackDto = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackDto = z.infer<typeof updateFeedbackSchema>;