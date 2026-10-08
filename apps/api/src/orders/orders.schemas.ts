import { z } from 'zod';

export const createOrderSchema = z.object({
  customer: z.string().min(1).max(64),
  phone: z.string().max(32).optional(),
  community: z.string().max(64).optional(),
  area: z.string().max(32).optional(),
  layout: z.string().max(32).optional(),
  needs: z.string().max(2000).optional(),
  rawInput: z.string().max(4000).optional(),
  budget: z.string().max(64).optional(),
  ecosystem: z.string().max(64).optional(),
});

export const updateOrderSchema = createOrderSchema.partial();

export const orderStatusSchema = z.object({
  status: z.enum(['new', 'qualified', 'proposed', 'quoted', 'won', 'lost']),
  lostReason: z.string().max(200).optional(),
  planId: z.string().uuid().optional(),
});

export const addNoteSchema = z.object({
  content: z.string().min(1).max(2000),
});

export const intakeSchema = z.object({
  rawInput: z.string().min(10).max(4000),
});

export type CreateOrderDto = z.infer<typeof createOrderSchema>;
export type UpdateOrderDto = z.infer<typeof updateOrderSchema>;
export type OrderStatusDto = z.infer<typeof orderStatusSchema>;
export type AddNoteDto = z.infer<typeof addNoteSchema>;
export type IntakeDto = z.infer<typeof intakeSchema>;
