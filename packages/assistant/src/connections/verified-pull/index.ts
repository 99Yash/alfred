/** Verified pull (#1192). Off the connections barrel because it reaches the MCP client cache. */

import type { ObjectStateProvider } from "@alfred/contracts";
import {
  defineVerifiedPull,
  type VerifiedPull,
  type VerifiedPullOutcome,
  type VerifiedPullTriggerItem,
} from "./driver";
import { railwayVerifiedPullProvider } from "./railway";
import { vercelVerifiedPullProvider } from "./vercel";

export {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullClock,
  type VerifiedPullItem,
  type VerifiedPullOutcome,
  type VerifiedPullProvider,
  type VerifiedPullReading,
  type VerifiedPullResult,
  type VerifiedPullTriggerItem,
} from "./driver";

export {
  discoverRailwayTargets,
  railwayTargetFromId,
  readRailwayDeploymentStatus,
  readRailwayMcpReadiness,
  type RailwayPullTarget,
} from "./railway";

export { gatherGithubMergedPullRequests, shippedFromGithubRead } from "./github";

export type {
  GithubMergedPullRequest,
  GithubMergedRead,
  GithubMergedReadOutcome,
} from "./github-merged-read";

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
  // GitHub reads merged pull requests per window, not one target per trigger mail. See `./github`.
  github: null,
  railway: defineVerifiedPull(railwayVerifiedPullProvider),
  vercel: defineVerifiedPull(vercelVerifiedPullProvider),
  // MCP health runs through the briefing loop verifier instead.
  mcp: null,
} as const satisfies Record<ObjectStateProvider, VerifiedPull | null>;

/**
 * Run every pull in registry order, one outcome per pull. A pull never throws, so one cannot
 * starve another.
 */
export async function gatherVerifiedPulls(args: {
  userId: string;
  digestItems: readonly VerifiedPullTriggerItem[];
}): Promise<VerifiedPullOutcome[]> {
  const outcomes: VerifiedPullOutcome[] = [];

  for (const pull of Object.values(VERIFIED_PULLS)) {
    if (pull) outcomes.push(await pull.gather(args));
  }

  return outcomes;
}
