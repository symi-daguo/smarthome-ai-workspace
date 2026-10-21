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
  /**
   * 计价方式：per_unit 按数量计价（默认）| per_order 按本单总价。
   * per_order 用于「整体安装服务」这类一次性收取的项，数量恒 1、单价即本单总价，
   * 避免同一笔钱既按设备计一遍又按服务费计一遍。
   */
  pricingMode: z.enum(['per_unit', 'per_order']).optional(),
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
  /** 幂等键：弱网重试不该重复生成整批产品图（可选） */
  clientRequestId: z.string().max(80).optional(),
});
export type AiProcessProductsDto = z.infer<typeof aiProcessProductsSchema>;

/**
 * 产品库导出：scope=mine 只导「我的产品库」；all=公共库+我的库。
 * format=csv 给 Excel 用，json 给程序用。
 */
export const exportProductsSchema = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  format: z.enum(['csv', 'json']).default('csv'),
});
export type ExportProductsDto = z.infer<typeof exportProductsSchema>;

/**
 * 产品库导入。
 *
 * rows 走 JSON（Agent / 程序用），csv 走文本（网页上传文件用）。
 * **两者至少给一个**（给 csv 时 rows 省略）——
 * 踩过的坑：原先 rows 是必填的，于是「只传 csv」会被校验拒掉，
 * 而那正是网页上传文件走的路径。
 */
export const importProductsSchema = z
  .object({
    rows: z
      .array(
        z.object({
          name: z.string().min(1, '产品名称不能为空').max(60),
          category: z.string().min(1, '品类不能为空').max(30),
          brand: z.string().max(40).optional(),
          model: z.string().max(40).optional(),
          unit: z.string().max(10).optional(),
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
          pricingMode: z.enum(['per_unit', 'per_order']).optional(),
          perRoom: z.string().max(60).optional(),
          imageUrl: z.string().max(500).optional(),
          iconKey: z.string().max(40).optional(),
        }),
      )
      .max(2000, '单次最多导入 2000 行')
      .optional(),
    /** CSV 文本（当 rows 为空时用它） */
    csv: z.string().max(2_000_000).optional(),
    /** 同名同品牌时是否覆盖已有产品（默认覆盖） */
    updateExisting: z.boolean().default(true),
  })
  .refine((v) => (v.rows?.length ?? 0) > 0 || !!v.csv?.trim(), {
    message: '请提供产品行（rows）或 CSV 文本（csv）之一',
    path: ['rows'],
  });
export type ImportProductsDto = z.output<typeof importProductsSchema>;

/**
 * 从品牌官网抓产品。
 *
 * mode=preview 只抓不落库（先看看抓到了什么）；
 * mode=import 抓完直接落到「我的产品库」。
 */
export const brandFetchSchema = z.object({
  /** 品牌官网的产品中心地址 */
  siteUrl: z.string().min(4, '请填写品牌官网地址').max(300),
  /** 品牌名（写进产品行的品牌字段） */
  brand: z.string().min(1, '请填写品牌名').max(40),
  mode: z.enum(['preview', 'import']).default('preview'),
  /** 同名同品牌是否覆盖已有产品（仅 import 模式有效，默认覆盖） */
  updateExisting: z.boolean().default(true),
});
export type BrandFetchDto = z.infer<typeof brandFetchSchema>;

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
