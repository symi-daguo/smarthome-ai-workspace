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
  // 「补充需求与服务资料」9 项：选填，全部走 max(2000)
  priorityNeeds: z.string().max(2000).optional().default(''),
  excludedItems: z.string().max(2000).optional().default(''),
  renovationStage: z.string().max(2000).optional().default(''),
  existingDevices: z.string().max(2000).optional().default(''),
  serviceEvidence: z.string().max(2000).optional().default(''),
  serviceScope: z.string().max(2000).optional().default(''),
  serviceContact: z.string().max(2000).optional().default(''),
  budgetItems: z.string().max(2000).optional().default(''),
  budgetSource: z.string().max(2000).optional().default(''),
  style: z.string().length(1).default('A'),
  edition: z.enum(['standard', 'presale', 'private']).default('standard'),
  // 交付模版：户型图设计样式 + 产品放置样式（取值见 web/src/data/planTemplates.ts）
  floorplanTemplate: z.enum(['annotated', 'compare', 'render']).default('annotated'),
  markerTemplate: z.enum(['numbered', 'icon', 'dot']).default('numbered'),
  pageCount: z.number().int().min(9).max(16).default(9),
  /** 提交幂等键：方案按页数扣费且要先调 LLM，重放的代价最高，必须防重复提交 */
  clientRequestId: z.string().max(64).optional(),
  // 户型平面图（MediaAsset id）与设备点位（来自点位布局编辑器，空间动线页配图用）
  floorplanAssetId: z.string().uuid().optional().nullable(),
  // 第 2、3 张户型图：创建方案时一并提交
  extraFloorplanAssetIds: z.array(z.string().uuid()).max(8).optional().default([]),
  // 每张图的楼层名，长度与「主图 + 额外图」一致
  floorplanFloors: z.array(z.string().max(20)).max(8).optional().default([]),
  // 装修效果图（≤5 张）与它们的分组元数据，两数组同序
  renderAssetIds: z.array(z.string().uuid()).max(5).optional().default([]),
  renderAssetMeta: z
    .array(
      z.object({
        clientId: z.string().max(60),
        room: z.string().max(30),
        roomConfirmed: z.boolean(),
        useMode: z.enum(['generate', 'provided']).default('generate'),
        sceneName: z.string().max(60).default(''),
        representative: z.boolean().default(false),
        fileName: z.string().max(120).default(''),
      }),
    )
    .max(5)
    .optional()
    .default([]),
  layoutPoints: z
    .array(
      z.object({
        productId: z.string().uuid(),
        name: z.string().max(60),
        category: z.string().max(30),
        // 所属房间名：点位清单与交付页按它与图上的编号对应
        room: z.string().max(20).optional(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .max(200)
    .optional()
    .nullable(),
});
/** 挂接户型图：主图 + 额外图（≤3 张）+ 每张的楼层名 */
export const attachFloorplanSchema = z.object({
  floorplanAssetId: z.string().uuid(),
  extraFloorplanAssetIds: z.array(z.string().uuid()).max(8).optional().default([]),
  floorplanFloors: z.array(z.string().max(20)).max(8).optional().default([]),
  layoutPoints: z
    .array(
      z.object({
        productId: z.string().uuid(),
        name: z.string().max(60),
        category: z.string().max(30),
        // 所属房间名：点位清单与交付页按它与图上的编号对应
        room: z.string().max(20).optional(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .max(200)
    .optional()
    .nullable(),
});

export type CreatePlanDto = z.infer<typeof createPlanSchema>;
export type AttachFloorplanDto = z.infer<typeof attachFloorplanSchema>;

export const updatePlanPageSchema = z.object({
  /**
   * 乐观锁版本号：客户端打开时看到的 versionNo。
   * 不传则不做冲突检测（保持老调用方行为）；传了而服务端已更新则 409。
   */
  versionNo: z.number().int().min(1).optional(),
  heading: z.string().max(200).optional(),
  subtitle: z.string().max(200).optional(),
  body: z.string().max(8000).optional(),
  narration: z.string().max(8000).optional(),
  /**
   * 页面要点（每页卡片式要点的文字来源）。
   * 此前 bullets 只由模型生成、前后端都改不了——门店想改一个措辞都做不到。
   * 上限 20 条是防粘贴滥用，不按页型卡死：卡死了用户在弹窗里会丢数据，
   * 而渲染侧本来就有 slice 兜底，超出的不显示而已。
   */
  bullets: z.array(z.string().max(300)).max(20).optional(),
  /** 底部引言（一页一句价值收束语） */
  quote: z.string().max(300).optional(),
});
export type UpdatePlanPageDto = z.infer<typeof updatePlanPageSchema>;

/**
 * 改交付模版：户型图设计样式 + 产品放置样式。
 * 取值与前端 data/planTemplates.ts 一一对应，改那边要同步改这里。
 */
export const updatePlanTemplatesSchema = z.object({
  /** 乐观锁版本号：客户端打开时看到的 versionNo，传了而服务端已更新则 409 */
  versionNo: z.number().int().min(1).optional(),
  floorplanTemplate: z.enum(['annotated', 'compare', 'render']).optional(),
  markerTemplate: z.enum(['numbered', 'icon', 'dot']).optional(),
});
export type UpdatePlanTemplatesDto = z.infer<typeof updatePlanTemplatesSchema>;

/** 给方案挂接户型图与设备点位（点位布局编辑器 → 方案空间动线页） */

/** 绑定场景视频：最多 2 条，每条须为 uuid */
export const bindVideosSchema = z.object({
  videoAssetIds: z.array(z.string().uuid('视频资产 id 不合法')).max(2, '最多绑定 2 条场景视频').default([]),
});
export type BindVideosDto = z.infer<typeof bindVideosSchema>;
