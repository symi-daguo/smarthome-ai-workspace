import { z } from 'zod';

export const llmTestSchema = z.object({
  /**
   * 模型名可省：省了就用 llm.constants.ts 里的默认模型。
   *
   * 此前这里是必填，与服务层 `model ?? DEFAULT_CHAT_MODEL` 的兜底逻辑自相矛盾——
   * Agent / curl 按「跟随默认」调用却拿到 400，只能被迫硬写一个模型名，
   * 写错就是 "unknown model"，反而更难懂。契约按真实能力放宽。
   */
  model: z.string().min(1).max(64).optional(),
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
