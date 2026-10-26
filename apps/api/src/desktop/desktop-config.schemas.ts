import { z } from 'zod';

/**
 * 桌面端设置保存 DTO。
 *
 * **四个字段全部可选**：只改请求里**出现**的字段，其余保持原样。
 * 前端表单回填的是「当前配置」，但令牌那栏永远空着（不回显明文），
 * 所以「空串」必须能被后端理解成「不改」而不是「清空」——
 * 这与模型配置中心对 apiKey 的既有语义一致（apps/api/src/llm/model-config.service.ts）。
 *
 * **长度上限**：配置文件是人手可读可改的 JSON，字段不加限制就可能被塞进几 MB 的串，
 * 把配置文件撑大、把日志撑大。给一个够用又不至于失控的上限。
 */
export const desktopConfigSchema = z.object({
  /** 品牌名（产品名）。留空 = 用内置默认名 */
  brandName: z.string().trim().max(80).optional(),
  /** 品牌图标地址（站内路径或完整 URL）。留空 = 沿用界面自带标识 */
  brandLogoUrl: z.string().trim().max(1000).optional(),
  /** 语音合成（讲解音频）服务地址。留空 = 本部署不提供语音（方案照常出三件套） */
  narrationTtsUrl: z.string().trim().max(1000).optional(),
  /** 语音合成服务令牌。空串 = 不改动；`__CLEAR__` = 清除已保存的令牌 */
  narrationTtsToken: z.string().trim().max(1000).optional(),
});
export type DesktopConfigDto = z.infer<typeof desktopConfigSchema>;
