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
/**
 * 灯光问诊：五项任务 + 每项 3 道选择题的答案。
 *
 * 任务与问题照参考站 `lighting-master.js` 的 MODES 定义（2026-10-16 REA 复核），
 * 选项文案也照抄——门店的提问路径是一样的，改了会让用户"这不是我知道的那个工具"。
 */
export const diagnoseSchema = z.object({
  modeId: z.string().min(1).max(40),
  /** { [questionId]: 选中的选项文案 } */
  answers: z.record(z.string(), z.string().max(80)),
  /** 幂等键：弱网重试不该重复扣额度（可选，不传则保持原行为） */
  clientRequestId: z.string().max(80).optional(),
  /** 上传的户型图/现场图（MediaAsset id），仅「上传图纸找问题」需要 */
  floorplanAssetId: z.string().uuid('图纸 id 不合法').optional(),
});
export type DiagnoseDto = z.infer<typeof diagnoseSchema>;
