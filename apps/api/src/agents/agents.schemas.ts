import { z } from 'zod';

/** 头像底色：与个人设置（/api/auth/profile）保持一致的六位十六进制规则 */
const avatarColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #RRGGBB');

export const createAgentSchema = z.object({
  name: z.string().min(1).max(30),
  description: z.string().max(200).optional(),
  // 人设/系统提示词：决定智能体身份、语气与输出格式
  systemPrompt: z.string().min(1).max(2000),
  avatarColor: avatarColorSchema.optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(30).optional(),
  description: z.string().max(200).optional(),
  systemPrompt: z.string().min(1).max(2000).optional(),
  avatarColor: avatarColorSchema.optional(),
  enabled: z.boolean().optional(),
});

export type CreateAgentDto = z.infer<typeof createAgentSchema>;
export type UpdateAgentDto = z.infer<typeof updateAgentSchema>;