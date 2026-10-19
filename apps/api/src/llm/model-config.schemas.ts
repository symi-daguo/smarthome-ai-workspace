import { z } from 'zod';

/**
 * 模型配置保存 DTO：
 *   - 文本字段传空串 = 清除该项（回退 .env 默认）
 *   - apiKey / comfyApiKey 传空串/缺省 = 保持已存密钥不变；「恢复 .env 默认」会整行删除（含密钥）
 */
const baseUrl = z.string().trim().max(200);
const apiKey = z.string().trim().max(200);
const model = z.string().trim().max(100);

export const chatConfigSchema = z.object({
  baseUrl: baseUrl.optional(),
  apiKey: apiKey.optional(),
  model: model.optional(),
});
export type ChatConfigDto = z.infer<typeof chatConfigSchema>;

export const imageConfigSchema = z.object({
  provider: z.enum(['minimax', 'openai', 'comfyui']).optional(),
  baseUrl: baseUrl.optional(),
  apiKey: apiKey.optional(),
  model: model.optional(),
  comfyBaseUrl: baseUrl.optional(),
  comfyApiKey: apiKey.optional(),
  workflowPath: z.string().trim().max(300).optional(),
  promptNode: z.string().trim().max(20).optional(),
  negativeNode: z.string().trim().max(20).optional(),
  latentNode: z.string().trim().max(20).optional(),
  seedNode: z.string().trim().max(20).optional(),
});
export type ImageConfigDto = z.infer<typeof imageConfigSchema>;

export const videoConfigSchema = z.object({
  provider: z.enum(['minimax', 'openai']).optional(),
  baseUrl: baseUrl.optional(),
  apiKey: apiKey.optional(),
  model: model.optional(),
});
export type VideoConfigDto = z.infer<typeof videoConfigSchema>;
