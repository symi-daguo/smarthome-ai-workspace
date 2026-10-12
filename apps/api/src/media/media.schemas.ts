import { z } from 'zod';

export const generateImageSchema = z.object({
  prompt: z.string().min(4, '请描述想要的画面').max(2000),
  size: z.enum(['1536x1024', '1024x1536', '1024x1024']).default('1536x1024'),
  model: z.enum(['pro', 'fast']).default('pro'),
  title: z.string().max(100).optional(),
});
export type GenerateImageDto = z.infer<typeof generateImageSchema>;

/** 图片反推提示词：上传资产 id（先经 /api/media/uploads 上传），视觉模型输出可直接用于文生图的描述 */
export const reverseImagePromptSchema = z.object({
  assetId: z.string().uuid('缺少已上传的参考图'),
});
export type ReverseImagePromptDto = z.infer<typeof reverseImagePromptSchema>;

export const generateVideoSchema = z.object({
  prompt: z.string().min(4, '请填写视频描述').max(2000),
  duration: z.union([z.literal(5), z.literal(10)]).default(5),
  resolution: z.enum(['480P', '720P', '1080P']).default('720P'),
  ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  /** 首帧图资产 id（先经 /api/media/uploads 上传或从我的资料选择）：传入则走 I2V-01-Director 图生视频 */
  firstFrameAssetId: z.string().min(1).max(40).optional(),
  title: z.string().max(100).optional(),
});
export type GenerateVideoDto = z.infer<typeof generateVideoSchema>;

/** 素材库购买：扣 1 元额度，返回本地素材文件 */
export const purchaseMaterialSchema = z.object({
  key: z.string().min(1).max(40),
});
export type PurchaseMaterialDto = z.infer<typeof purchaseMaterialSchema>;

/** 重命名我的资料（图片/视频）：本租户产物，最基本的修改能力 */
export const renameAssetSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(100),
});
export type RenameAssetDto = z.infer<typeof renameAssetSchema>;

