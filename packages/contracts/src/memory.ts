import { z } from "zod";

export const jsonRecordSchema = z.record(z.string(), z.unknown());

export const memorySourceSchema = z.object({
  kind: z.enum(["document", "chunk", "tool_call", "cold_start", "user", "agent"]),
  id: z.string().optional(),
  meta: jsonRecordSchema.optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;
