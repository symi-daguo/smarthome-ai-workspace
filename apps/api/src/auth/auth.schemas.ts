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

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
