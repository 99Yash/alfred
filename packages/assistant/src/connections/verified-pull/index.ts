/**
 * The verified-pull door (#1192). Kept off the `@alfred/assistant/connections`
 * barrel for the same reason `./mcp` is: a provider's read reaches the MCP
 * live-client cache and the credential vault, which that barrel must not
 * evaluate.
 */

import type { IntegrationActivityItem, ObjectStateProvider } from "@alfred/contracts";
import { defineVerifiedPull, type VerifiedPull, type VerifiedPullTriggerItem } from "./driver";
import { railwayVerifiedPullProvider } from "./railway";
import { vercelVerifiedPullProvider } from "./vercel";

export {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullProvider,
  type VerifiedPullReading,
  type VerifiedPullResult,
  type VerifiedPullStatus,
  type VerifiedPullTriggerItem,
} from "./driver";

export {
  discoverRailwayTargets,
  readRailwayDeploymentStatus,
  readRailwayMcpReadiness,
  type RailwayPullTarget,
} from "./railway";

export { discoverVercelTargets, readVercelDeploymentStatus, type VercelPullTarget } from "./vercel";

export {
  verifyApprovedMcpHealth,
  type ApprovedMcpHealthCallInput,
  type ApprovedMcpHealthDependencies,
  type ApprovedMcpHealthLoop,
  type ApprovedMcpHealthLoopResult,
  type CurrentMcpHealthMapping,
} from "./health";

/**
 * Which verified pull each object-state provider runs at gather time. `null`
 * is the arm for a provider with a push source (or none yet), so a provider
 * added to the registry without a row here is a type error, and adding a pull
 * provider is one row here plus its implementation file — never a gather edit.
 */
const VERIFIED_PULLS = {
  github: null,
  sentry: null,
  railway: defineVerifiedPull(railwayVerifiedPullProvider),
  vercel: defineVerifiedPull(vercelVerifiedPullProvider),
  // Generic MCP health reads are data-driven by owner-approved descriptors, so
  // they run through the briefing loop verifier rather than target discovery.
  mcp: null,
} as const satisfies Record<ObjectStateProvider, VerifiedPull | null>;

/**
 * Run every registered verified pull, in registry order, and return their
 * verdict lines. Each provider's pull never throws (a fault resolves to no
 * lines and leaves every loop live), so one provider cannot starve another.
 */
export async function gatherVerifiedPulls(args: {
  userId: string;
  digestItems: readonly VerifiedPullTriggerItem[];
}): Promise<IntegrationActivityItem[]> {
  const items: IntegrationActivityItem[] = [];

  for (const pull of Object.values(VERIFIED_PULLS)) {
    if (pull) items.push(...(await pull.gather(args)));
  }

  return items;
}
