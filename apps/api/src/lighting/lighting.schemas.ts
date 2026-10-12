import { z } from 'zod';

export const createSceneSchema = z.object({
  title: z.string().min(1).max(60),
  // 参考效果图（MediaAsset id）与出片产物（MediaAsset id）
  sourceAssetId: z.string().uuid('参考效果图 id 不合法').optional(),
  ratio: z.string().min(1).max(16).optional(),
  // 灯具数组 [{id,type,name,x,y,brightness,colorTemp,alwaysDim,order}]（x/y 归一化 0-1）
  // 只校验最外层是数组，内部元素由前端负责
  fixtures: z.array(z.json()),
  // 时间轴 {durationMs,tracks:[{fixtureId,keyframes:[{t,brightness,colorTemp}]}]}
  // 只校验最外层是对象，内部结构由前端负责
  timeline: z.record(z.string(), z.json()),
  videoAssetId: z.string().uuid('出片资产 id 不合法').optional(),
});

export const updateSceneSchema = createSceneSchema.partial();

export type CreateSceneDto = z.infer<typeof createSceneSchema>;
export type UpdateSceneDto = z.infer<typeof updateSceneSchema>;