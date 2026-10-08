import {
  canonicalizeVercelTargetId,
  emailDomain,
  INTEGRATIONS,
  parseEmailAddress,
  parseGitBranchRef,
} from "@alfred/contracts";
import { vercelClientForUser, type VercelClient } from "@alfred/integrations/vercel";
import { VERCEL_PULL_EVENT_TYPE } from "../object-state/vercel-reducer";
import {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullProvider,
  type VerifiedPullReading,
  type VerifiedPullReceipt,
  type VerifiedPullStatus,
  verifiedPullVerdict,
} from "./driver";

/**
 * Vercel's half of the verified pull (#1193). The push half is `reduceVercelEvent`;
 * both fold into one `owner/repo#branch#environment` target row.
 *
 * Reads go over the curated Vercel grant, not Vercel MCP: its auth server accepts
 * only loopback redirects (`docs/plans/vercel-mcp-retirement.md`).
 * A deployment counts only if it names its own repo, branch, and environment.
 */
/** The identity the dispatch and the pull share. */
export interface VercelPullTarget {
  repoFullName: string;
  branch: string;
  environment: string;
}

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

interface VercelReadSession {
  client: VercelClient;
  projects: readonly VercelProjectRef[];
  /** One read per project per gather, shared by every target. */
  deployments: Map<string, Promise<VercelDeploymentReading[] | null>>;
}

/** Sent as the list limit, so it also caps the deployments calls per session. */
const VERCEL_PROJECT_SCAN_LIMIT = 10;

/** Safe only because `/v6/deployments` is newest first: the cap drops the oldest. */
const VERCEL_DEPLOYMENT_READ_LIMIT = 100;

/** `null` for no grant or a refused grant; the driver treats both the same. */
async function openVercelRead(userId: string): Promise<VercelReadSession | null> {
  try {
    // No retry: a gather waits on this, and the next gather tries again (as ADR-0104).
    const client = vercelClientForUser({ userId, retry: "none" });
    const listed = await client.projects({ limit: VERCEL_PROJECT_SCAN_LIMIT });

    return {
      client,
      projects: listed.map((project) => ({
        projectId: project.id,
        name: project.name,
        linkedRepo: project.linkedRepo,
      })),
      deployments: new Map(),
    };
  } catch {
    return null;
  }
}

/** Exact match only: `CANCELED`, `DELETED`, or an unknown state reads as `null`. */
function collapseVercelState(state: string | null | undefined): VerifiedPullStatus | null {
  switch (state) {
    case "READY":
      return "success";
    case "ERROR":
      return "failure";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "pending";
    default:
      return null;
  }
}

function parseProviderInstant(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? null : time;
}

/** Readable deployments of one project, newest first, cached per gather. `null` proves nothing. */
function readProjectDeployments(
  session: VercelReadSession,
  project: VercelProjectRef,
): Promise<VercelDeploymentReading[] | null> {
  const cached = session.deployments.get(project.projectId);

  if (cached) return cached;

  const pending = session.client
    .deployments({ projectId: project.projectId, limit: VERCEL_DEPLOYMENT_READ_LIMIT })
    .then((deployments) => {
      const readings: VercelDeploymentReading[] = [];

      for (const deployment of deployments) {
        const status = collapseVercelState(deployment.state);
        const branch = deployment.git?.ref ? parseGitBranchRef(deployment.git.ref) : null;

        // Only the deployment's own claim names a target; never infer it from the project.
        if (!status || !branch || !deployment.git || deployment.target === null) continue;

        const target: VercelPullTarget = {
          repoFullName: `${deployment.git.org}/${deployment.git.repo}`,
          branch,
          environment: deployment.target ?? "preview",
        };

        const targetId = canonicalizeVercelTargetId(target);

        if (!targetId) continue;

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
      return readings.sort(
        (a, b) =>
          (b.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY) -
          (a.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY),
      );
    })
    // An error proves nothing, so return `null`, never a partial reading.
    .catch(() => null);

  session.deployments.set(project.projectId, pending);

  return pending;
}

/** Projects linked to the target's repo, or with an unknown link. */
function candidateProjects(
  session: VercelReadSession,
  target: VercelPullTarget,
): VercelProjectRef[] {
  const repo = target.repoFullName.toLowerCase();

  return session.projects.filter(
    (project) => project.linkedRepo === null || project.linkedRepo.toLowerCase() === repo,
  );
}

/** The newest deployment across candidate projects that names this target, or `null`. */
async function readVercelDeploymentStatusFromSession(
  session: VercelReadSession,
  target: VercelPullTarget,
): Promise<VerifiedPullReading | null> {
  const targetId = canonicalizeVercelTargetId(target);

  if (!targetId) return null;

  let latest: VerifiedPullReading | null = null;

  for (const project of candidateProjects(session, target)) {
    const readings = await readProjectDeployments(session, project);
    const match = readings?.find((item) => item.targetId === targetId);

    if (!match) continue;

    const matchTime = match.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY;
    const latestTime = latest?.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY;

    if (!latest || matchTime > latestTime) latest = match.reading;
  }

  return latest;
}

/** Any failure returns `null`, never a guessed state. */
export async function readVercelDeploymentStatus(
  userId: string,
  target: VercelPullTarget,
): Promise<VerifiedPullReading | null> {
  try {
    const session = await openVercelRead(userId);

    return session ? await readVercelDeploymentStatusFromSession(session, target) : null;
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
      for (const item of (await readProjectDeployments(session, project)) ?? []) {
        if (targets.size >= limit) return [...targets.values()];

        if (!targets.has(item.targetId)) targets.set(item.targetId, item.target);
      }
    }

    return [...targets.values()];
  } catch {
    return [];
  }
}

/** The only minter of the pull shape `reduceVercelEvent` folds. Takes a parsed reading, never text. */
export function mintVercelPullReceipt(
  target: VercelPullTarget,
  parsed: VerifiedPullReading,
): VerifiedPullReceipt {
  return {
    eventType: VERCEL_PULL_EVENT_TYPE,
    payload: {
      target: {
        repoFullName: target.repoFullName,
        branch: target.branch,
        environment: target.environment,
      },
      deployment: {
        id: parsed.attemptId,
        status: parsed.status,
        createdAt: parsed.providerEventTime?.toISOString() ?? null,
        url: parsed.url,
      },
    },
  };
}

export const vercelVerifiedPullProvider: VerifiedPullProvider<
  VercelPullTarget,
  VercelReadSession,
  never
> = {
  provider: "vercel",
  targetKind: "deployment_target",
  attemptKeyKind: "deployment_id",

  /** Exact Vercel domain (not `info.vercel.com` marketing) plus a failure word. Only triggers a read. */
  digestSignalsFailure(items) {
    return items.some((item) => {
      if (emailDomain(parseEmailAddress(item.from)) !== INTEGRATIONS.vercel.domain) return false;

      return /fail|error|unable to deploy/i.test(`${item.subject ?? ""} ${item.snippet ?? ""}`);
    });
  },

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
