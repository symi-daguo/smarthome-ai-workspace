import { z } from 'zod';

export const generateImageSchema = z.object({
  prompt: z.string().min(4, '请描述想要的画面').max(2000),
  size: z.enum(['1536x1024', '1024x1536', '1024x1024']).default('1536x1024'),
  /**
   * 适配视频：出图统一按 16:9 视频画幅，并在提示词追加「保持原图构图不被裁切」。
   * 语义——原图保留，首帧与效果图使用同一构图，可直接拿去做视频首帧。
   */
  fitVideo: z.boolean().default(false),
  /** 背景意图：transparent / white 会写进提示词约束；auto 不干预 */
  background: z.enum(['auto', 'transparent', 'white']).default('auto'),
  /**
   * 提交幂等键（可选）：弱网超时重试、跨标签页重复提交时带同一个键，
   * 命中已有产物直接返回，不再出图也不再扣额度。不带则行为与从前完全一致。
   */
  clientRequestId: z.string().max(64).optional(),
  /**
   * 局部重绘：原图资产 id + 遮罩 dataURL（二者必须同时提供）。
   * 遮罩约定与 OpenAI 官方一致：**全透明区域会被重绘，不透明区域保持原样**
   * （OpenAI Images API 对 mask 的定义即 "fully transparent areas indicate where the image should be edited"，
   *  与 `RegionSelector` 把圈选处「擦」成透明的做法一致）。
   * 目前只有 provider=openai 支持（走 images/edits），其余 provider 会明确拒绝而不是静默忽略。
   */
  imageAssetId: z.string().max(40).optional(),
  maskDataUrl: z.string().max(2_000_000).optional(),
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
  /**
   * 提交幂等键（可选）：与生图同一个机制。视频单价高于图片，重复提交代价更大，
   * 弱网超时重试或跨标签页重复点都会造成重复扣费。
   */
  clientRequestId: z.string().max(64).optional(),
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


/** 素材库投稿：先经 /api/media/uploads 上传拿到 assetId，再提交审核 */
export const submitMaterialSchema = z.object({
  assetId: z.string().min(1, '请先上传素材文件'),
  title: z.string().trim().min(1, '标题不能为空').max(60),
  desc: z.string().trim().max(500).default(''),
});
export type SubmitMaterialDto = z.infer<typeof submitMaterialSchema>;
