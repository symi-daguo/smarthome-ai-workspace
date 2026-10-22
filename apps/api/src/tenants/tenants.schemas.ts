import { z } from 'zod';

export const grantTokensSchema = z.object({
  amount: z.number().int().positive().max(1_000_000_000),
  reason: z.string().min(1).max(64).optional(),
});

/**
 * 工作台设置：名称 + 安装调试费率。
 *
 * installRate 是报价清单里「安装调试费」的计取比例（按设备参考零售合计的百分比）。
 * 省略不传 = 不改这一项 —— 改名不该顺带把费率重置回默认。
 */
export const updateTenantSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(24, '名称最多 24 字').optional(),
  installRate: z.number().int().min(0, '费率不能为负').max(100, '费率最高 100%').optional(),
}).refine((v) => v.name !== undefined || v.installRate !== undefined, {
  message: '没有要修改的项',
});

export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;
export type GrantTokensDto = z.infer<typeof grantTokensSchema>;
