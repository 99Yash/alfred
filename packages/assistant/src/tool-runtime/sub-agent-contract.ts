import { coerceJsonArrayFields, LOADABLE_INTEGRATION_SLUGS } from "@alfred/contracts";
import { z } from "zod";

import { joinToolInput } from "./join-contract";

// Here, not in execution, because the tool definitions and the spawn code both read them.

export const subAgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "subId may only contain letters, numbers, underscores, and dashes");

export const spawnSubAgentInputSchema = coerceJsonArrayFields(
  ["allowedIntegrations"],
  z
    .object({
      subId: subAgentIdSchema,
      brief: z.string().min(1).max(8_000),
      allowedIntegrations: z.array(z.enum(LOADABLE_INTEGRATION_SLUGS)).default([]),
    })
    .strict(),
);

export type SpawnSubAgentInput = z.infer<typeof spawnSubAgentInputSchema>;

/** Derived from `joinToolInput`, because the join arm reads the child id without `execute`. */
export const awaitSubAgentInputSchema = joinToolInput.strict();
