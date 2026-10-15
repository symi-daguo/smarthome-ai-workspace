import { z } from 'zod';

const priceField = z.number().int().min(0).max(10_000_000);
const rebateField = z.number().int().min(0).max(100, '返点不能超过 100%');

export const createProductSchema = z.object({
  name: z.string().min(1).max(60),
  // 品类 key：预置 39 类或租户自定义（校验在 service 层按 CategoryDef 白名单）
  category: z.string().min(1).max(30),
  brand: z.string().max(40).optional(),
  model: z.string().max(40).optional(),
  unit: z.string().max(10).optional(),
  priceMin: priceField.optional(),
  priceMax: priceField.optional(),
  perRoom: z.string().max(60).optional(),
  imageUrl: z.string().max(200).optional(),
  // 产品级图标 key（product-icons.ts 的 PRODUCT_ICON_KEYS）；空串=回退品类图标
  iconKey: z.string().max(40).optional(),
  // 标准产品主数据
  sku: z.string().max(40).optional(),
  barcode: z.string().max(20).optional(),
  snRule: z.string().max(40).optional(),
  spec: z.string().max(120).optional(),
  warranty: z.number().int().min(0).max(600).optional(),
  priceRetail: priceField.optional(),
  priceDealer: priceField.optional(),
  priceProject: priceField.optional(),
  rebateL1: rebateField.optional(),
  rebateL2: rebateField.optional(),
  rebateDesigner: rebateField.optional(),
});
export const updateProductSchema = createProductSchema.partial();
export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;

/** 自定义品类：label 中文名，icon 从预置 lucide 图标 key 里选 */
export const createCategorySchema = z.object({
  label: z.string().min(1).max(20),
  icon: z.string().min(1).max(30).default('radar'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#888888'),
});
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

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
