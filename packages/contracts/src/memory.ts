import { z } from "zod";
import { jsonObjectSchema } from "./user-model";

export const memorySourceSchema = z.object({
  kind: z.enum(["document", "chunk", "tool_call", "cold_start", "user", "agent"]),
  id: z.string().optional(),
  meta: jsonObjectSchema.optional(),
});

export type MemorySource = z.infer<typeof memorySourceSchema>;
