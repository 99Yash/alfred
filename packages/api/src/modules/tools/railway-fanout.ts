/**
 * Pure (DB-free) helpers for the Railway tools: credential selection and the
 * cross-credential project fan-out. Kept separate from railway.ts so this logic
 * is unit-testable without a database — the DB read lives in railway.ts and is
 * passed in here as plain data / an injected lister.
 */

import { type RailwayDeployment, type RailwayProject } from "@alfred/integrations/railway";
import type { ActiveBearerCredential } from "@alfred/integrations/shared";
import { AppError, toPublicAppError, type PublicAppError } from "../../lib/app-errors";
import { logger } from "../../lib/logger";

export interface RailwayCredentialRef {
  credentialId: string;
  credentialLabel: string;
  credentialAccountId: string;
}

export type RailwayProjectWithCredential = RailwayProject & RailwayCredentialRef;
export type RailwayDeploymentWithCredential = RailwayDeployment & RailwayCredentialRef;

/**
 * A deployment surfaced by the cross-project activity sweep. Carries the project
 * and service it belongs to (the flat `RailwayDeployment` only knows a
 * `serviceId`) so the boss can say "alfred / server redeployed" without a second
 * lookup, plus the credential provenance every fan-out result gets.
 */
export interface RailwayRecentDeployment extends RailwayDeploymentWithCredential {
  projectId: string;
  projectName: string;
  /** Resolved from the project's service list by `serviceId`; null if unknown. */
  serviceName: string | null;
}

export interface RailwayFanoutFailure extends PublicAppError {
  credentialId: string;
  credentialLabel: string;
}

export function credentialLabel(credential: ActiveBearerCredential): string {
  return credential.accountLabel ?? credential.accountId;
}

export function credentialRef(credential: ActiveBearerCredential): RailwayCredentialRef {
  return {
    credentialId: credential.id,
    credentialLabel: credentialLabel(credential),
    credentialAccountId: credential.accountId,
  };
}

export function withCredential<T extends object>(
  value: T,
  credential: ActiveBearerCredential,
): T & RailwayCredentialRef {
  return { ...value, ...credentialRef(credential) };
}

/**
 * Pick the credential a follow-up tool should act through. With `credentialId`
 * omitted we default to the sole connection; with several connected we require
 * an explicit choice rather than guess which account to read or mutate.
 */
export function pickCredential(
  credentials: ActiveBearerCredential[],
  credentialId?: string,
): ActiveBearerCredential {
  if (credentialId) {
    const credential = credentials.find((c) => c.id === credentialId);
    if (!credential) {
      throw new AppError("railway_credential_required");
    }
    return credential;
  }
  const [sole] = credentials;
  if (sole && credentials.length === 1) return sole;
  throw new AppError("railway_credential_required");
}

/**
 * Fan a project listing out across every connected credential, de-duped by
 * project id (first credential, newest-updated, wins) and tagged with its
 * provenance. With several credentials, a failure on any one is tolerated as
 * long as another succeeds (even with zero projects): the failing credential is
 * recorded in `failures` rather than aborting the fan-out, whether it failed
 * authz (a stale token) or transiently (a 5xx / timeout) — a sibling's result
 * still matters more than one bad hop. Only an all-failed fan-out throws. With a
 * single credential there is no sibling to fall back to, so the original error
 * is surfaced verbatim for the boss to relay.
 */
export async function listProjectsForCredentials(
  credentials: ActiveBearerCredential[],
  listProjects: (token: string) => Promise<{ projects: RailwayProject[] }>,
): Promise<{ projects: RailwayProjectWithCredential[]; failures: RailwayFanoutFailure[] }> {
  // Fan out concurrently — the credentials are independent round-trips, each up
  // to a 30s timeout, so serializing them is pure latency. Merge the settled
  // results in the ORIGINAL credential order (newest-updated first) so the
  // de-dupe stays deterministic ("first credential wins") regardless of which
  // request happened to resolve first.
  const settled = await Promise.allSettled(
    credentials.map((credential) => listProjects(credential.accessToken)),
  );
  // With a single credential there is no sibling to fall back to, so fail with
  // a safe actionable error while retaining the provider detail only as cause.
  if (credentials.length === 1 && settled[0]?.status === "rejected") {
    throw new AppError("railway_unavailable", { cause: settled[0].reason });
  }

  const projectsById = new Map<string, RailwayProjectWithCredential>();
  const failures: RailwayFanoutFailure[] = [];
  let anySucceeded = false;
  settled.forEach((outcome, index) => {
    const credential = credentials[index];
    if (!credential) return;
    if (outcome.status === "fulfilled") {
      anySucceeded = true;
      for (const project of outcome.value.projects) {
        if (!projectsById.has(project.id)) {
          projectsById.set(project.id, withCredential(project, credential));
        }
      }
      return;
    }
    // A sibling may still answer, so record the failure and keep going.
    const failure = toPublicAppError(outcome.reason, "railway_account_read_failed");
    logger.error(
      {
        err: outcome.reason,
        event: "railway_account_read_failed",
        credentialId: credential.id,
      },
      failure.message,
    );
    failures.push({
      credentialId: credential.id,
      credentialLabel: credentialLabel(credential),
      ...failure,
    });
  });
  // Only an *all-failed* fan-out is an error. A credential that succeeded with
  // zero projects (empty workspace) must not be reported as a failure. List the
  // provider details remain in the per-account safe logs above.
  if (!anySucceeded && failures.length > 0) {
    throw new AppError("railway_unavailable");
  }
  return { projects: [...projectsById.values()], failures };
}

/** Newest first; a deployment with no `createdAt` can't claim recency, so it sorts last. */
function byCreatedAtDesc(a: RailwayRecentDeployment, b: RailwayRecentDeployment): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  return (Number.isNaN(bt) ? -Infinity : bt) - (Number.isNaN(at) ? -Infinity : at);
}

/**
 * Cross-project deployment activity sweep. Railway's `deployments` query requires
 * a `projectId`, so "what deployed recently across everything" is a two-level
 * fan-out: list every project across every credential (reusing
 * {@link listProjectsForCredentials} and its partial-failure tolerance), then
 * read each project's recent deployments concurrently, tag them with project +
 * service + credential, merge, sort newest-first, and cap.
 *
 * Partial failures are tolerated the same way as the project fan-out: one
 * project (or credential) failing to answer is recorded in `failures` and the
 * sweep still returns everything else — an activity digest with most of the
 * picture beats an all-or-nothing throw. `listProjectsForCredentials` still
 * throws if the projects can't be read at all (nothing to sweep).
 */
export async function listRecentDeploymentsForCredentials(
  credentials: ActiveBearerCredential[],
  listProjects: (token: string) => Promise<{ projects: RailwayProject[] }>,
  listDeployments: (args: {
    token: string;
    projectId: string;
    limit: number;
  }) => Promise<{ deployments: RailwayDeployment[] }>,
  opts?: { perProjectLimit?: number; overallLimit?: number },
): Promise<{ deployments: RailwayRecentDeployment[]; failures: RailwayFanoutFailure[] }> {
  const perProjectLimit = opts?.perProjectLimit ?? 5;
  const overallLimit = opts?.overallLimit ?? 15;

  const { projects, failures } = await listProjectsForCredentials(credentials, listProjects);

  // `RailwayProjectWithCredential` carries only the credential *ref*, but the
  // deployments read needs the access token — recover it by credential id.
  const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));

  const settled = await Promise.allSettled(
    projects.map(async (project): Promise<RailwayRecentDeployment[]> => {
      const credential = credentialById.get(project.credentialId);
      // A project only surfaced because its credential listed it, so the lookup
      // always resolves; guard defensively rather than assert.
      if (!credential) return [];
      const { deployments } = await listDeployments({
        token: credential.accessToken,
        projectId: project.id,
        limit: perProjectLimit,
      });
      const serviceNameById = new Map(project.services.map((s) => [s.id, s.name]));
      return deployments.map((deployment) => ({
        ...withCredential(deployment, credential),
        projectId: project.id,
        projectName: project.name,
        serviceName: deployment.serviceId
          ? (serviceNameById.get(deployment.serviceId) ?? null)
          : null,
      }));
    }),
  );

  const deployments: RailwayRecentDeployment[] = [];
  const deploymentFailures: RailwayFanoutFailure[] = [...failures];
  settled.forEach((outcome, index) => {
    const project = projects[index];
    if (!project) return;
    if (outcome.status === "fulfilled") {
      deployments.push(...outcome.value);
      return;
    }
    // Tolerate one project's failure — the sweep still returns the rest.
    const failure = toPublicAppError(outcome.reason, "railway_account_read_failed");
    logger.error(
      {
        err: outcome.reason,
        event: "railway_project_deployments_read_failed",
        credentialId: project.credentialId,
        projectId: project.id,
      },
      failure.message,
    );
    deploymentFailures.push({
      credentialId: project.credentialId,
      credentialLabel: project.credentialLabel,
      ...failure,
    });
  });

  deployments.sort(byCreatedAtDesc);
  return { deployments: deployments.slice(0, overallLimit), failures: deploymentFailures };
}
