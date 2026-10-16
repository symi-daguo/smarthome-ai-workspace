import { z } from 'zod';

export const llmTestSchema = z.object({
  model: z.string().min(1).max(64),
  prompt: z.string().min(1).max(2000),
  systemPrompt: z.string().max(1000).optional(),
  /**
   * 附件（dataURL 内联）。
   *
   * 此前前端只把「文件名(类型, 大小)」拼进 prompt 摘要，**模型根本看不到附件内容**——
   * 用户传了 PDF 却以为 AI 读过了，比没有这个功能更糟。这里把真内容带上去。
   */
  attachments: z
    .array(
      z.object({
        name: z.string().max(200),
        /** data:image/png;base64,… 或 data:text/plain;base64,… */
        dataUrl: z.string().max(6_000_000),
      }),
    )
    .max(5, '单次最多 5 个附件')
    .optional(),
});

export type LlmTestDto = z.infer<typeof llmTestSchema>;
