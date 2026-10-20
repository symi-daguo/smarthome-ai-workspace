import { z } from 'zod';
import { PERMISSIONS } from '../rbac/permissions.js';

/**
 * 自定义角色入参（0.1.54）
 *
 * `permissions` 是**白名单校验**而不是 z.enum：权限表是部署时可扩展的，
 * 用 enum 写死会让「以后加一个权限动作」必须同时改 schema、seed 与这里三处。
 * 参考 Appwrite 的做法：角色 = 一份扁平权限串清单，校验走白名单。
 */
const permissionList = z
  .array(z.enum(PERMISSIONS))
  .max(PERMISSIONS.length)
  // 去重：同一动作传两次没意义，但也不该因此报错
  .transform((v) => [...new Set(v)]);

export const createRoleSchema = z.object({
  name: z.string().trim().min(1, '角色名不能为空').max(30, '角色名最多 30 字'),
  /** 这个岗位具体干什么，会显示在角色卡片上 */
  description: z.string().trim().max(120).optional(),
  permissions: permissionList.refine((v) => v.length > 0, '至少要选一项权限，否则这个角色什么都做不了'),
});

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  description: z.string().trim().max(120).optional(),
  permissions: permissionList.refine((v) => v.length > 0, '至少要选一项权限').optional(),
});

export type CreateRoleDto = z.infer<typeof createRoleSchema>;
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

/** 成员创建/改角色时用：系统模板 key 或自定义角色 id 都接受 */
export const assignRoleSchema = z.object({
  /** 传 key（如 tenant_admin）或自定义角色 id */
  role: z.string().trim().min(1).max(64),
});
