import { z } from 'zod';

export const docTypeSchema = z.enum(['product', 'meeting', 'generic']);

export const urlExtractSchema = z.object({
  docType: docTypeSchema.default('product'),
  url: z.string().url('请输入合法的 URL').max(2000),
});
export type UrlExtractDto = z.infer<typeof urlExtractSchema>;

export const transcriptExtractSchema = z.object({
  docType: z.enum(['product', 'meeting', 'generic']).default('meeting'),
  title: z.string().max(100).optional(),
  text: z.string().min(20, '纪要内容至少 20 个字符').max(200_000),
});
export type TranscriptExtractDto = z.infer<typeof transcriptExtractSchema>;

export const confirmExtractionSchema = z.object({
  fields: z.record(z.string(), z.string().max(2000)),
  action: z.enum(['confirm', 'reject']).default('confirm'),
});
export type ConfirmExtractionDto = z.infer<typeof confirmExtractionSchema>;
