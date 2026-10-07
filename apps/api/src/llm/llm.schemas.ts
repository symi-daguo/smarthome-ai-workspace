import { z } from 'zod';

export const llmTestSchema = z.object({
  model: z.string().min(1).max(64),
  prompt: z.string().min(1).max(2000),
  systemPrompt: z.string().max(1000).optional(),
});

export type LlmTestDto = z.infer<typeof llmTestSchema>;
