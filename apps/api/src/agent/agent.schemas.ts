import { z } from 'zod';

/**
 * Agent 机器接入的请求体校验。
 *
 * 一律走 zod（与全项目一致，不引入 class-validator）。
 */

/**
 * 角色标识。
 *
 * 刻意**不用 z.enum**：枚举一旦写死，seed 里加一个角色就必须在多处同步，
 * 否则界面能选、接口却 400 —— 权限模型出现多个真相来源。
 * 这里只做形状校验，「角色是否存在」交给 service 查 Role 表判定（不存在则 ROLE_NOT_FOUND）。
 * 同理接受自定义角色的 id。
 */
export const roleRefSchema = z.string().trim().min(1).max(64);

export const serviceAccountSchema = z.object({
  /** 展示名，如「数据分析 Agent」 */
  name: z.string().trim().min(1).max(60),
  /** 角色决定权限，走现有 RBAC；默认 tenant_admin（最小权限应显式选 viewer） */
  roleKey: roleRefSchema.default('tenant_admin'),
});

export const apiKeySchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** 有效期天数，默认 90，上限 365。过期后自动失效 */
  ttlDays: z.number().int().min(1).max(365).default(90),
  /** 为服务账号建 Key 时传；不给则给当前登录用户自己建 */
  serviceAccountId: z.string().uuid().optional(),
});

export const snapshotSchema = z.object({
  /** 人可读标签，出事时要靠它认出这份快照是哪一步打的 */
  label: z.string().trim().min(1).max(120),
  trigger: z.enum(['manual', 'auto']).default('manual'),
});

export const restoreSchema = z.object({
  /**
   * 二次确认串。必须等于快照 id 的前 8 位，防止 Agent 手滑调错快照把数据整租户还原掉。
   * 空串不允许 —— 宁可多一步，也不要「一个 restore 打错参数就没了」。
   */
  confirm: z.string().trim().min(4).max(16),
  /** 默认 true：快照里没有、但快照之后新建的数据一并删掉，这才是真正的「回到操作前」 */
  dropNewer: z.boolean().default(true),
});

export type ServiceAccountDto = z.infer<typeof serviceAccountSchema>;
export type ApiKeyDto = z.infer<typeof apiKeySchema>;
export type SnapshotDto = z.infer<typeof snapshotSchema>;
export type RestoreDto = z.infer<typeof restoreSchema>;