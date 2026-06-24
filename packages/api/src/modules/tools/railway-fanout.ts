/**
 * Pure (DB-free) helpers for the Railway tools: credential selection and the
 * cross-credential project fan-out. Kept separate from railway.ts so this logic
 * is unit-testable without a database — the DB read lives in railway.ts and is
 * passed in here as plain data / an injected lister.
 */

import { toMessage } from "@alfred/contracts";
import { type RailwayDeployment, type RailwayProject } from "@alfred/integrations/railway";
import type { ActiveBearerCredential } from "@alfred/integrations/shared";

export interface RailwayCredentialRef {
  credentialId: string;
  credentialLabel: string;
  credentialAccountId: string;
}

export type RailwayProjectWithCredential = RailwayProject & RailwayCredentialRef;
export type RailwayDeploymentWithCredential = RailwayDeployment & RailwayCredentialRef;

export interface RailwayFanoutFailure {
  credentialId: string;
  credentialLabel: string;
  message: string;
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
      throw new Error(
        `[railway.credentials] Railway credential '${credentialId}' is not active or connected`,
      );
    }
    return credential;
  }
  const [sole] = credentials;
  if (sole && credentials.length === 1) return sole;
  // List only the ids (not the labels, which can be an email): the boss already
  // has the id→label mapping from list_projects output, and the thrown message
  // is persisted verbatim into executeError telemetry.
  const choices = credentials.map((c) => c.id).join(", ");
  throw new Error(
    `[railway.credentials] multiple Railway credentials connected. Pass credentialId from list_projects (one of: ${choices})`,
  );
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
  // With a single credential there is no sibling to fall back to, so surface the
  // original error verbatim (the boss asks the user to reconnect).
  if (credentials.length === 1 && settled[0]?.status === "rejected") throw settled[0].reason;

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
    failures.push({
      credentialId: credential.id,
      credentialLabel: credentialLabel(credential),
      message: toMessage(outcome.reason),
    });
  });
  // Only an *all-failed* fan-out is an error. A credential that succeeded with
  // zero projects (empty workspace) must not be reported as a failure. List the
  // ids (not labels) in the thrown message — it lands verbatim in telemetry.
  if (!anySucceeded && failures.length > 0) {
    throw new Error(
      `[railway.credentials] no Railway credential could list projects: ${failures
        .map((f) => `${f.credentialId}: ${f.message}`)
        .join("; ")}`,
    );
  }
  return { projects: [...projectsById.values()], failures };
}
