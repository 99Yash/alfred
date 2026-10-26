import { canonicalizeVercelTargetId, parseGitBranchRef } from "@alfred/contracts";
import {
  vercelClientForUser,
  type VercelClient,
  type VercelProject,
} from "@alfred/integrations/vercel";
import { z } from "zod";
import { VERIFIED_PULL_EVENT_TYPE, type VercelPullEvent } from "../object-state";
import {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullProvider,
  type VerifiedPullRead,
  type VerifiedPullReading,
  type VerifiedPullStatus,
  verifiedPullVerdict,
} from "./driver";

/**
 * Vercel's half of the verified pull (#1193). The push half is `reduceVercelEvent`;
 * both fold into one `owner/repo#branch#environment` target row.
 *
 * Reads go over the curated Vercel grant, not Vercel MCP: its auth server accepts
 * only loopback redirects (`docs/plans/vercel-mcp-retirement.md`). The client reads
 * `/v10/projects` and `/v7/deployments` with the install's `team_id` as `?teamId=`.
 * Both shapes were measured from the production container on 2026-10-17 and matched (#1193).
 * A body the client's schema refuses still throws, and the throw reads as unverified here.
 * A deployment counts only if it names its own repo, branch, and environment.
 */

/** The identity the dispatch and the pull share. The fold input owns the shape. */
export type VercelPullTarget = VercelPullEvent["payload"]["target"];

interface VercelProjectRef {
  projectId: string;
  name: string;
  linkedRepo: string | null;
}

interface VercelDeploymentReading {
  project: VercelProjectRef;
  targetId: string;
  target: VercelPullTarget;
  reading: VerifiedPullReading;
}

/** One project's deployment list. */
interface VercelProjectDeployments {
  /** Readable deployments, newest first. */
  readings: VercelDeploymentReading[];
  /** Targets with a deployment in a state outside `VERCEL_DEPLOYMENT_STATES`. A miss on one is a fault. */
  unknownStateTargets: ReadonlySet<string>;
}

interface VercelReadSession {
  client: VercelClient;
  projects: readonly VercelProjectRef[];
  /**
   * Projects of a repo the scan missed, by lowercased `owner/repo`, or `null` after a fault. One
   * lookup per repo per gather.
   */
  repoProjects: Map<string, Promise<VercelProjectRef[] | null>>;
  /** One read per project per gather, shared by every target. */
  deployments: Map<string, Promise<VercelProjectDeployments | null>>;
}

/** Sent as the list limit of the scan and of each repo lookup, so it also caps the deployments calls. */
const VERCEL_PROJECT_SCAN_LIMIT = 10;

/** Safe only because `/v7/deployments` is newest first: the cap drops the oldest. */
const VERCEL_DEPLOYMENT_READ_LIMIT = 100;

function toProjectRef(project: VercelProject): VercelProjectRef {
  return { projectId: project.id, name: project.name, linkedRepo: project.linkedRepo };
}

/** `repo` is a lowercased `owner/repo`. */
function linksRepo(project: VercelProjectRef, repo: string): boolean {
  return project.linkedRepo?.toLowerCase() === repo;
}

/** `null` for no grant or a refused grant; the driver treats both the same. */
async function openVercelRead(userId: string): Promise<VercelReadSession | null> {
  try {
    // No retry: a gather waits on this, and the next gather tries again (as ADR-0104).
    const client = vercelClientForUser({ userId, retry: "none" });
    const listed = await client.projects({ limit: VERCEL_PROJECT_SCAN_LIMIT });

    return {
      client,
      projects: listed.map(toProjectRef),
      repoProjects: new Map(),
      deployments: new Map(),
    };
  } catch {
    return null;
  }
}

/** Vercel's documented deployment states. The client keeps the wire value a `string`. */
const VERCEL_DEPLOYMENT_STATES = [
  "READY",
  "ERROR",
  "BUILDING",
  "INITIALIZING",
  "QUEUED",
  "CANCELED",
  "DELETED",
] as const;

const vercelDeploymentStateSchema = z.enum(VERCEL_DEPLOYMENT_STATES);

/**
 * `satisfies` forces a verdict for every documented state. `null`: the deployment proves no health,
 * so it is skipped, and a target with only such deployments can read as `absent`.
 */
const VERDICT_BY_VERCEL_STATE = {
  READY: "success",
  ERROR: "failure",
  BUILDING: "pending",
  INITIALIZING: "pending",
  QUEUED: "pending",
  CANCELED: null,
  DELETED: null,
} satisfies Record<(typeof VERCEL_DEPLOYMENT_STATES)[number], VerifiedPullStatus | null>;

/** `"unknown"` for a missing state or one this build does not know: a miss is then a fault. */
function collapseVercelState(
  state: string | null | undefined,
): VerifiedPullStatus | null | "unknown" {
  const known = vercelDeploymentStateSchema.safeParse(state);

  return known.success ? VERDICT_BY_VERCEL_STATE[known.data] : "unknown";
}

function parseProviderInstant(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? null : time;
}

/** Deployments of one project, cached per gather. `null` proves nothing. */
function readProjectDeployments(
  session: VercelReadSession,
  project: VercelProjectRef,
): Promise<VercelProjectDeployments | null> {
  const cached = session.deployments.get(project.projectId);

  if (cached) return cached;

  const pending = session.client
    .deployments({ projectId: project.projectId, limit: VERCEL_DEPLOYMENT_READ_LIMIT })
    .then((deployments) => {
      const readings: VercelDeploymentReading[] = [];
      const unknownStateTargets = new Set<string>();

      for (const deployment of deployments) {
        const status = collapseVercelState(deployment.state);
        const branch = deployment.git?.ref ? parseGitBranchRef(deployment.git.ref) : null;

        // Only the deployment's own claim names a target; never infer it from the project.
        if (status === null || !branch || !deployment.git || !deployment.environment) continue;

        const target: VercelPullTarget = {
          repoFullName: `${deployment.git.org}/${deployment.git.repo}`,
          branch,
          environment: deployment.environment,
        };

        const targetId = canonicalizeVercelTargetId(target);

        if (!targetId) continue;

        if (status === "unknown") {
          unknownStateTargets.add(targetId);
          continue;
        }

        const url = deployment.url ?? null;

        readings.push({
          project,
          targetId,
          target,
          reading: {
            status,
            attemptId: deployment.uid,
            providerEventTime: parseProviderInstant(deployment.createdAt),
            url: url && !url.includes("://") ? `https://${url}` : url,
          },
        });
      }

      // Do not trust server order. No instant sorts last; ties keep server order.
      readings.sort(
        (a, b) =>
          (b.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY) -
          (a.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY),
      );

      return { readings, unknownStateTargets };
    })
    // An error proves nothing, so return `null`, never a partial reading.
    .catch(() => null);

  session.deployments.set(project.projectId, pending);

  return pending;
}

/**
 * Projects linked to the repo, by Vercel's `repoUrl` filter (#1351). Measured 2026-10-17: the
 * filter matches the owner case-sensitively, so send the display case, not the lowercased id. Only
 * an exact link counts. A fault returns `null`, so it is not taken for a repo with no project.
 */
function lookupRepoProjects(
  session: VercelReadSession,
  repoFullName: string,
): Promise<VercelProjectRef[] | null> {
  const repo = repoFullName.toLowerCase();
  const cached = session.repoProjects.get(repo);

  if (cached) return cached;

  const pending = session.client
    .projects({ limit: VERCEL_PROJECT_SCAN_LIMIT, repoUrl: `https://github.com/${repoFullName}` })
    .then((listed) => listed.map(toProjectRef).filter((project) => linksRepo(project, repo)))
    .catch(() => null);

  session.repoProjects.set(repo, pending);

  return pending;
}

/**
 * The newest reading across the projects that names the target. `faulted`: a list faulted, or held
 * a deployment of the target in an unknown state, so a miss proves nothing.
 */
async function newestTargetReading(
  session: VercelReadSession,
  projects: readonly VercelProjectRef[],
  targetId: string,
): Promise<{ latest: VerifiedPullReading | null; faulted: boolean }> {
  let latest: VerifiedPullReading | null = null;
  let faulted = false;

  for (const project of projects) {
    const listed = await readProjectDeployments(session, project);

    if (!listed || listed.unknownStateTargets.has(targetId)) faulted = true;

    const match = listed?.readings.find((item) => item.targetId === targetId);

    if (!match) continue;

    const matchTime = match.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY;
    const latestTime = latest?.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY;

    if (!latest || matchTime > latestTime) latest = match.reading;
  }

  return { latest, faulted };
}

/**
 * The newest deployment that names this target, across scanned projects linked to its repo or with
 * an unknown link. The scan holds only the most recent projects, so the repo is also looked up when
 * the scan links no project to it, and before a miss counts as `absent`. A fault that could hide a
 * match returns `null`.
 */
async function readVercelDeploymentStatusFromSession(
  session: VercelReadSession,
  target: VercelPullTarget,
): Promise<VerifiedPullRead> {
  const targetId = canonicalizeVercelTargetId(target);

  if (!targetId) return null;

  const repo = target.repoFullName.toLowerCase();

  const scanned = session.projects.filter(
    (project) => project.linkedRepo === null || linksRepo(project, repo),
  );

  const fromScan = await newestTargetReading(session, scanned, targetId);

  if (fromScan.latest && scanned.some((project) => project.linkedRepo !== null)) {
    return fromScan.latest;
  }

  const repoProjects = await lookupRepoProjects(session, target.repoFullName);

  // Cached per gather, so the scanned projects are not read again.
  const all = await newestTargetReading(session, [...scanned, ...(repoProjects ?? [])], targetId);

  if (all.latest) return all.latest;

  return repoProjects === null || all.faulted ? null : "absent";
}

/** Any failure, and a read that finds the target `absent`, returns `null`, never a guessed state. */
export async function readVercelDeploymentStatus(
  userId: string,
  target: VercelPullTarget,
): Promise<VerifiedPullReading | null> {
  try {
    const session = await openVercelRead(userId);
    const reading = session ? await readVercelDeploymentStatusFromSession(session, target) : null;

    return reading === "absent" ? null : reading;
  } catch {
    return null;
  }
}

/** Bootstrap targets before any row exists: the first `limit` distinct ones. A fault finds none. */
export async function discoverVercelTargets(
  userId: string,
  limit: number = MAX_VERIFIED_PULL_TARGETS,
): Promise<VercelPullTarget[]> {
  try {
    const session = await openVercelRead(userId);

    if (!session) return [];

    const targets = new Map<string, VercelPullTarget>();

    for (const project of session.projects) {
      for (const item of (await readProjectDeployments(session, project))?.readings ?? []) {
        if (targets.size >= limit) return [...targets.values()];

        if (!targets.has(item.targetId)) targets.set(item.targetId, item.target);
      }
    }

    return [...targets.values()];
  } catch {
    return [];
  }
}

/** The only minter of the pull event `reduceVercelEvent` folds. Takes a parsed reading, never text. */
function mintVercelPullReceipt(
  target: VercelPullTarget,
  reading: VerifiedPullReading,
): VercelPullEvent {
  return { provider: "vercel", eventType: VERIFIED_PULL_EVENT_TYPE, payload: { target, reading } };
}

export const vercelVerifiedPullProvider: VerifiedPullProvider<
  VercelPullEvent,
  VercelPullTarget,
  VercelReadSession,
  never
> = {
  provider: "vercel",
  targetKind: "deployment_target",
  attemptKeyKind: "deployment_id",

  /**
   * The `repository_dispatch` push folds every real failure into the target row, which puts the
   * row in rotation, so a failure mail would read nothing new (#1357).
   */
  digestSignalsFailure: null,

  /**
   * Segments cannot hold `#`, so a three-part split is exact. The id is lowercased,
   * so `row.repo` gives the display case when it agrees.
   */
  targetFromRow(row) {
    const [repoFullName, branch, environment, ...rest] = row.externalId.split("#");

    if (!repoFullName || !branch || !environment || rest.length > 0) return null;

    const repo = row.repo?.toLowerCase() === repoFullName ? row.repo : repoFullName;

    return { repoFullName: repo, branch, environment };
  },

  canonicalTargetId: canonicalizeVercelTargetId,
  discoverTargets: discoverVercelTargets,
  openSession: openVercelRead,
  // The target already carries every name the verdict line needs.
  resolveNames: async () => new Map<string, never>(),
  readStatus: readVercelDeploymentStatusFromSession,
  mintReceipt: mintVercelPullReceipt,

  toActivityItem(result) {
    const where = `${result.target.repoFullName} ${result.target.branch} (${result.target.environment})`;

    const { word, ...verdict } = verifiedPullVerdict(result);

    return {
      id: `vercel-pull:${result.targetId || "unknown"}:${result.attemptId ?? "unverified"}`,
      provider: "vercel",
      source: "direct_api",
      activityCategory: "deploy",
      providerKind: "vercel.deployment_status",
      title: `Vercel deployment ${word}: ${where}`,
      ...verdict,
    };
  },
};
