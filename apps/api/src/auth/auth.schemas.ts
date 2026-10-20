import { z } from 'zod';

export const phoneSchema = z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确');

export const registerSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(8).max(64),
  displayName: z.string().min(1).max(32),
  tenantName: z.string().min(1).max(64).optional(),
});

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1).max(64),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(64),
  newPassword: z.string().min(8).max(64),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(32).optional(),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #RRGGBB').optional(),
  // 头像图片 URL：只接受本平台 media 路径与 http(s)，空串表示清除回退到底色
  // 只收本平台 media 路径：放开 http(s) 等于允许把任意第三方地址塞进头像位，
  // 界面会替用户去请求那个地址（跟踪像素、钓鱼图都可能）。要外链请让部署者自己改。
  avatarUrl: z.string().max(300).refine((v) => v === '' || v.startsWith('/api/media/'), '头像只能使用本平台上传的图片').optional(),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
