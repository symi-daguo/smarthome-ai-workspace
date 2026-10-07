import { z } from 'zod';

export const createLayoutSchema = z.object({
  title: z.string().min(1, '请输入图纸名称').max(100),
  mediaAssetId: z.string().uuid('缺少户型底图'),
  points: z
    .array(
      z.object({
        productId: z.string().uuid(),
        name: z.string().max(60),
        category: z.string().max(30),
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
