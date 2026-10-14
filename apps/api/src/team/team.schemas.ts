import { z } from 'zod';

/**
 * 团队成员管理入参（0.1.54）
 *
 * 设计取向：管理员**不需要理解权限串**，只需要选一个「角色模板」。
 * 权限 action 只出现在模板详情里供查阅，不作为「新建成员」时的表单字段 ——
 * 让非技术同事逐项勾 15 个权限串，既容易配错也没人配得下去。
 */

/** 与 prisma/seed.ts 的 ROLE_DEFS 保持同步；这是**可选模板**，不是必填枚举，
 *  服务端会再查一次 Role 表确认存在，避免角色被删后接口仍然宣称支持 */
export const roleKeySchema = z.string().trim().min(1).max(40);

export const createMemberSchema = z.object({
  /** 登录手机号，全租户唯一（User.phone 是 @unique） */
  phone: z.string().trim().regex(/^1[3-9]\d{9}$/, '手机号格式不对，应为 11 位且以 1 开头'),
  displayName: z.string().trim().min(1).max(40),
  /** 角色模板 key：super_admin / tenant_admin / designer / operator / viewer */
  roleKey: roleKeySchema,
  /** 初始密码：由管理员线下告知本人，首次登录后建议自行修改 */
  password: z
    .string()
    .min(8, '初始密码至少 8 位')
    .max(72, '密码过长')
    .regex(/[A-Za-z]/, '密码需含字母')
    .regex(/\d/, '密码需含数字'),
});

export const updateMemberSchema = z.object({
  /** 改角色模板。改不了手机号——那是登录身份，改了等于换人 */
  roleKey: roleKeySchema,
});

export type CreateMemberDto = z.infer<typeof createMemberSchema>;
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>;