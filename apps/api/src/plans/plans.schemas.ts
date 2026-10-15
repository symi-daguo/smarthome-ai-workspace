import { z } from 'zod';

export const createPlanSchema = z.object({
  title: z.string().min(2, '请输入项目名称').max(100),
  customer: z.string().max(50).optional().default(''),
  area: z.string().max(50).optional().default(''),
  budget: z.string().max(50).optional().default(''),
  ecosystem: z.string().max(100).optional().default(''),
  store: z.string().max(100).optional().default(''),
  highlights: z.string().max(500).optional().default(''),
  keySpaces: z.string().max(300).optional().default(''),
  needs: z.string().max(2000).optional().default(''),
  style: z.string().length(1).default('A'),
  edition: z.enum(['standard', 'presale', 'private']).default('standard'),
  pageCount: z.number().int().min(9).max(16).default(9),
  /** 提交幂等键：方案按页数扣费且要先调 LLM，重放的代价最高，必须防重复提交 */
  clientRequestId: z.string().max(64).optional(),
  // 户型平面图（MediaAsset id）与设备点位（来自点位布局编辑器，空间动线页配图用）
  floorplanAssetId: z.string().uuid().optional().nullable(),
  layoutPoints: z
    .array(
      z.object({
        productId: z.string().uuid(),
        name: z.string().max(60),
        category: z.string().max(30),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .max(200)
    .optional()
    .nullable(),
});
export type CreatePlanDto = z.infer<typeof createPlanSchema>;

export const updatePlanPageSchema = z.object({
  heading: z.string().max(200).optional(),
  body: z.string().max(8000).optional(),
  narration: z.string().max(8000).optional(),
});
export type UpdatePlanPageDto = z.infer<typeof updatePlanPageSchema>;

/** 给方案挂接户型图与设备点位（点位布局编辑器 → 方案空间动线页） */
export const attachFloorplanSchema = z.object({
  floorplanAssetId: z.string().uuid(),
  layoutPoints: createPlanSchema.shape.layoutPoints,
});
export type AttachFloorplanDto = z.infer<typeof attachFloorplanSchema>;
