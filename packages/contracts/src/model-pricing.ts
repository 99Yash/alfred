import { z } from "zod";

export const modelPriceTierSchema = z.object({
  minInputTokens: z.number().int().positive(),
  inputPerMtok: z.number().nonnegative(),
  outputPerMtok: z.number().nonnegative(),
  cachedInputPerMtok: z.number().nonnegative().nullable(),
  cacheWriteInputPerMtok: z.number().nonnegative().nullable(),
  cacheWrite1hPerMtok: z.number().nonnegative().nullable(),
});

export type ModelPriceTier = z.infer<typeof modelPriceTierSchema>;

export const modelPricingMetadataSchema = z.object({
  cacheWrite1hPerMtok: z.number().nonnegative().nullable().default(null),
  tiers: z.array(modelPriceTierSchema).default([]),
});

export type ModelPricingMetadata = z.infer<typeof modelPricingMetadataSchema>;
