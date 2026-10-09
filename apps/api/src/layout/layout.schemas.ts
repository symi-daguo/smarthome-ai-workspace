import { z } from 'zod';

export const CATEGORIES = ['gateway', 'switch', 'sensor', 'light', 'curtain', 'security', 'appliance', 'audio', 'hvac'] as const;

export const createProductSchema = z.object({
  name: z.string().min(1).max(60),
  category: z.enum(CATEGORIES),
  brand: z.string().max(40).optional(),
  model: z.string().max(40).optional(),
  unit: z.string().max(10).optional(),
  priceMin: z.number().int().min(0).max(1_000_000).optional(),
  priceMax: z.number().int().min(0).max(1_000_000).optional(),
  perRoom: z.string().max(60).optional(),
  imageUrl: z.string().max(200).optional(),
});
export const updateProductSchema = createProductSchema.partial();
export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;

/** AI 批量处理产品资料：ids=勾选的产品行 id（我的库行生成文案+产品图；公共库行仅生成产品图） */
export const aiProcessProductsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, '请先勾选要处理的产品').max(20, '单次上限 20 个'),
});
export type AiProcessProductsDto = z.infer<typeof aiProcessProductsSchema>;

export const createLayoutSchema = z.object({
  title: z.string().min(1, '请输入图纸名称').max(100),
  mediaAssetId: z.string().uuid('缺少户型底图'),
  points: z
    .array(
      z.object({
        productId: z.string().uuid(),
        name: z.string().max(60),
        category: z.string().max(30),
        // 产品主图（有图点位用产品照片作图标，无图回退品类 SVG）
        iconUrl: z.string().max(200).optional(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .max(200, '点位过多（上限 200）'),
});
export type CreateLayoutDto = z.infer<typeof createLayoutSchema>;

export const updateLayoutSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  points: createLayoutSchema.shape.points.optional(),
});
export type UpdateLayoutDto = z.infer<typeof updateLayoutSchema>;
