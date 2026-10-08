/** Verified pull (#1192). Off the connections barrel because it reaches the MCP client cache. */

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

/** `null` for a provider with no pull. A new provider without a row is a type error. */
const VERIFIED_PULLS = {
  github: null,
  sentry: null,
  railway: defineVerifiedPull(railwayVerifiedPullProvider),
  vercel: defineVerifiedPull(vercelVerifiedPullProvider),
  // MCP health runs through the briefing loop verifier instead.
  mcp: null,
} as const satisfies Record<ObjectStateProvider, VerifiedPull | null>;

/** Run every pull in registry order. A pull never throws, so one cannot starve another. */
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
