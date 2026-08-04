import { coerceJsonArrayFields, LOADABLE_INTEGRATION_SLUGS } from "@alfred/contracts";
import { z } from "zod";

import { joinToolInput } from "./join-contract";

/**
 * Input contracts for the sub-agent system tools (`system.spawn_sub_agent` /
 * `system.await_sub_agent`). They live at the tool-runtime boundary, not in
 * agent, because two owners must agree on them and must not drift: the tools
 * registry declares them on the system-tool definitions, and the agent's
 * spawn/join implementation derives from them. All three are plain Zod
 * constraints with no agent dependency, so the tools module reads them without
 * importing agent.
 */

/** The identity of a spawned sub-agent — letters, numbers, underscores, dashes. */
export const subAgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "subId may only contain letters, numbers, underscores, and dashes");

/** The `system.spawn_sub_agent` tool input: a sub id, a brief, and an integration cap. */
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

/**
 * The `system.await_sub_agent` tool input. Derived from `joinToolInput` rather
 * than restated: the dispatcher's `staging: "join"` arm resolves the child run
 * from that field WITHOUT going through this tool's `execute`, so the two must
 * not be able to drift. `.strict()` is the local addition — the join contract
 * is a floor.
 */
export const awaitSubAgentInputSchema = joinToolInput.strict();
