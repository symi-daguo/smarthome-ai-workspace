import { z } from 'zod';

export const generateImageSchema = z.object({
  prompt: z.string().min(4, '请描述想要的画面').max(2000),
  size: z.enum(['1536x1024', '1024x1536', '1024x1024']).default('1536x1024'),
  model: z.enum(['pro', 'fast']).default('pro'),
  title: z.string().max(100).optional(),
});
export type GenerateImageDto = z.infer<typeof generateImageSchema>;

export const generateVideoSchema = z.object({
  prompt: z.string().min(4, '请填写视频描述').max(2000),
  duration: z.union([z.literal(5), z.literal(10)]).default(5),
  resolution: z.enum(['480P', '720P', '1080P']).default('720P'),
  title: z.string().max(100).optional(),
});
export type GenerateVideoDto = z.infer<typeof generateVideoSchema>;

/** 素材库购买：扣 1 元额度，返回本地素材文件 */
export const purchaseMaterialSchema = z.object({
  key: z.string().min(1).max(40),
});
export type PurchaseMaterialDto = z.infer<typeof purchaseMaterialSchema>;

