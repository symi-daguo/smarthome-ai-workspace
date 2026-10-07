import { z } from 'zod';

export const grantTokensSchema = z.object({
  amount: z.number().int().positive().max(1_000_000_000),
  reason: z.string().min(1).max(64).optional(),
});

export type GrantTokensDto = z.infer<typeof grantTokensSchema>;
