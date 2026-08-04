import { z } from "zod";

/**
 * The input every `staging: "join"` tool must accept, because the dispatcher's
 * join arm reads `childRunId` off the call to resolve which child run to park on
 * — it does not go through the tool's own `execute`. It lives at the tool-runtime
 * boundary because two owners must agree on it and must not drift: the tools
 * registry proves at boot that each join tool accepts this shape, the dispatch
 * join arm PARSES it instead of casting a name-matched input, and the agent's
 * `awaitSubAgentInputSchema` derives from it. A mis-declared join tool then
 * fails at boot rather than at first dispatch, where the cast would have yielded
 * `undefined` typed as `string` and queried for a run that cannot exist.
 */
export const joinToolInput = z.object({ childRunId: z.string().min(1) });
