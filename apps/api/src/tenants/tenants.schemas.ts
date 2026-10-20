import { z } from 'zod';

export const grantTokensSchema = z.object({
  amount: z.number().int().positive().max(1_000_000_000),
  reason: z.string().min(1).max(64).optional(),
});

/** 工作台改名：租户名会显示在侧栏顶部与分享页 */
export const updateTenantSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(24, '名称最多 24 字'),
});

export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;
export type GrantTokensDto = z.infer<typeof grantTokensSchema>;
