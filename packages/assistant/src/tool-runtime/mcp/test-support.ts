/**
 * Policy seeding and broker replacement for tests only, kept off the product door
 * (`@alfred/assistant/tool-runtime/mcp`) for the reason
 * `packages/assistant/src/action-policies/test-support.ts` states: a name only a
 * test wants should cost a subpath called `test-support`, not a place on the
 * interface production reads.
 *
 * `upsertToolPolicy` writes the reviewed-downgrade row that ADR-0088 makes the one
 * input able to lower an MCP call BELOW the risk floor. Nothing in `src` mints one
 * — the approval flow does, and it does not live here yet. Its guard,
 * `readToolPolicy`, is the name the door would need if any of this were product
 * surface, and it is deliberately not published either: the pair is private to
 * `invocations.ts`, where `resolveMcpToolIdentity` is the single fail-closed reader.
 *
 * `_setMcpExecutionBrokerForTests` drops the process-lifetime broker singleton.
 * Nothing in `src` replaces it, and the same rule already put its twin
 * `_setMcpConnectionManagerForTests` behind
 * `@alfred/assistant/connections/mcp/test-support`: the two singletons are
 * independent since the module split, so replacing either one from product code
 * would leave the other holding a stale view of the same connection.
 *
 * This module is behind an exact `exports` key, but note the door beside it is
 * tier 4, not tier 1: `"./tool-runtime/*"` already republishes every leaf under the
 * directory, so `invocations` itself resolves regardless. Campaign item 79 owns
 * narrowing that wildcard; until it lands this file is a convention, and after it
 * lands it becomes the fence it reads as.
 */

export { upsertToolPolicy } from "./invocations";
export { _setMcpExecutionBrokerForTests } from "./runtime";
