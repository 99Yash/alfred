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
 * Vercel's half of the verified pull (#1193) — the second
 * {@link VerifiedPullProvider}, and the pull half of Vercel's succession shape.
 * The push half is the relayed `repository_dispatch` (`reduceVercelEvent`).
 * Both halves fold into the same `owner/repo#branch#environment` target row,
 * so a pull success after a push failure (or the reverse) is one succession.
 *
 * The read goes over the user's CURATED Vercel grant — the OAuth app install
 * that already ships in `@alfred/integrations/vercel` — and not over Vercel's
 * MCP server. It read over MCP between 2026-09-23 and 2026-09-27 and could
 * never have worked: Vercel's authorization server accepts only loopback
 * redirect URIs, so a hosted Alfred cannot register a client with it at all.
 * `docs/plans/vercel-mcp-retirement.md` carries the measurement and the four
 * ways around it that do not exist.
 *
 * The transport swap is the whole change. The grant is not a second door to
 * Vercel: `@alfred/integrations/vercel` is the ONE door, and this file holds no
 * token, no base URL, and no response schema. It asks for projects and
 * deployments and applies the attribution rules, which are unchanged and are
 * the part that decides what a fold may assert.
 *
 * Two things got simpler, both because the grant is team-scoped where the MCP
 * session was not. There is no `list_teams` step: the credential already
 * carries the `team_id` the install was made on and the client pins it as
 * `?teamId=` on every call. And there is no issuer gate to pass — a grant is
 * either present and scoped, or there is no session.
 *
 * What did not change is what a read must prove. No credential, a remote error,
 * and a deployment that does not name its own repository, branch, and
 * environment all prove nothing and leave the loop live. The attribution is the
 * deployment's OWN claim and is never inferred from the project it sits in.
 */

/** A Vercel deployment target: the identity the dispatch and the pull share. */
export interface VercelPullTarget {
  repoFullName: string;
  branch: string;
  environment: string;
}

/** A project the read may scan, and the repo its Git link names, when known. */
interface VercelProjectRef {
  projectId: string;
  name: string;
  linkedRepo: string | null;
}

/** One deployment, parsed and attributed to the target it belongs to. */
interface VercelDeploymentReading {
  project: VercelProjectRef;
  targetId: string;
  target: VercelPullTarget;
  reading: VerifiedPullReading;
}

interface VercelReadSession {
  client: VercelClient;
  projects: readonly VercelProjectRef[];
  /** One deployments read per project per gather, shared by every target. */
  deployments: Map<string, Promise<VercelDeploymentReading[] | null>>;
}

/**
 * How many projects one read session scans for deployments. Every target read
 * in a session shares the per-project cache, so this caps the deployments
 * calls of one session. It is passed to Vercel as the list limit rather than
 * applied afterwards, so the cap bounds the bytes on the wire and not just the
 * loop. A gather opens at most two sessions (bootstrap discovery, then the
 * reads).
 */
const VERCEL_PROJECT_SCAN_LIMIT = 10;

/**
 * How many deployments one project read asks for.
 *
 * Vercel answers `/v6/deployments` newest first, so this cap drops the OLDEST
 * deployments of a busy project and cannot drop the newest one a target is
 * waiting on — which is the only deployment the read acts on. That ordering is
 * the load-bearing part: a cap on a newest-last list would silently hide the
 * deployment this pull exists to find, and the invariant that a truncated read
 * proves nothing would have to extend to every project over the limit. Stated
 * here rather than left to the client's own default so the number is a decision
 * this file can see.
 */
const VERCEL_DEPLOYMENT_READ_LIMIT = 100;

/**
 * Open the user's Vercel grant and list the projects the read may scan.
 *
 * `null` means there is no usable session, and the two reasons are deliberately
 * indistinguishable to the caller because the driver treats them the same: no
 * connected Vercel grant, and a grant Vercel refused. The client raises on the
 * first request when the credential is absent, so the whole open is guarded
 * rather than probing for a grant first — a probe would be a second request
 * that can fail the same way.
 */
async function openVercelRead(userId: string): Promise<VercelReadSession | null> {
  try {
    // One attempt, no retry: a gather waits on this, and a provider that is
    // already down should cost one timeout rather than several. A failed read
    // leaves the loop live and the next gather tries again, which is the same
    // reasoning ADR-0104 records for the Drive source.
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

/**
 * Collapse a Vercel deployment state into the registry's outcome vocabulary.
 * Byte-exact on the provider enum: `CANCELED`, `DELETED`, a future state, or a
 * casing drift reads as unknown, and absence never closes.
 */
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

/**
 * Every readable deployment of one project, newest provider instant first,
 * each attributed to the target its own Git metadata names. Read once per
 * project per gather. `null` means the read proved nothing.
 */
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

        // The target is the deployment's OWN claim, never inferred: a deployment
        // that does not name its repo, branch, and environment belongs to no
        // target, so it cannot close one. `git` is the client's resolution of
        // Vercel's two spellings, so org and repo arrive together or not at all.
        //
        // `target` is `string | null` here and was `string | null | undefined`
        // over MCP. REST always sends the key, and `null` already means preview,
        // so the ABSENT case this guarded is no longer representable and would
        // not compile if it were left in.
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

      // Server order is a claim, not a contract. The newest provider instant
      // comes first; an absent instant sorts last, and the stable sort keeps
      // server order among ties.
      return readings.sort(
        (a, b) =>
          (b.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY) -
          (a.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY),
      );
    })
    // A remote error or a malformed body proves nothing about current state, so
    // it is the same `null` a missing grant is, never a partial reading.
    .catch(() => null);

  session.deployments.set(project.projectId, pending);

  return pending;
}

/**
 * The projects that may hold this target's deployments: a project whose Git
 * link names the target's repo, or whose link is unknown. A project linked to
 * another repo cannot hold them.
 */
function candidateProjects(
  session: VercelReadSession,
  target: VercelPullTarget,
): VercelProjectRef[] {
  const repo = target.repoFullName.toLowerCase();

  return session.projects.filter(
    (project) => project.linkedRepo === null || project.linkedRepo.toLowerCase() === repo,
  );
}

/**
 * Read current deployment state for one target: the newest readable
 * deployment, across the candidate projects, whose own metadata names this
 * target. A target with no such deployment reads as null, never a guess.
 */
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

/**
 * Read current deployment state for one target over the user's curated Vercel
 * grant. No usable grant, unknown output, or a transport fault is never a
 * guessed state.
 */
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

/**
 * Discover pull targets from the user's recent Vercel deployments — the
 * bootstrap, before any target row exists. Bounded: the first `limit` distinct
 * targets, newest deployment first within each project, projects in provider
 * order. A transport fault discovers nothing, so the loop stays live.
 */
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

/**
 * Mint the pull receipt body for a parsed status — the ONLY constructor of the
 * pull shape `reduceVercelEvent` folds. It takes a {@link VerifiedPullReading},
 * never text, so an email string or adapter output cannot construct it.
 */
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

  /**
   * A surfaced digest item signaling a Vercel deployment failure. Deliberately
   * narrow: the sender's domain IS `INTEGRATIONS.vercel.domain` (so
   * `ship@info.vercel.com` marketing does not qualify) AND a failure word sits
   * in the subject or snippet. Trigger-only: it causes a read, never an
   * assertion.
   */
  digestSignalsFailure(items) {
    return items.some((item) => {
      if (emailDomain(parseEmailAddress(item.from)) !== INTEGRATIONS.vercel.domain) return false;

      return /fail|error|unable to deploy/i.test(`${item.subject ?? ""} ${item.snippet ?? ""}`);
    });
  },

  /**
   * The external id is the canonical `owner/repo#branch#environment` form,
   * and `canonicalizeVercelTargetId` refuses a `#` in any segment, so a
   * three-part split recovers the target. The id folds the repo's case, so
   * the row's `repo` column supplies the display spelling when it agrees.
   * Anything else is a row this build did not write — dropped, never pulled.
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
  // The verdict line names the target by repo, branch, and environment, which
  // the target itself carries, so there is nothing further to resolve.
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
