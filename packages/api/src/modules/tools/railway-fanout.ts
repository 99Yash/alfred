/**
 * Pure (DB-free) helpers for the Railway tools: credential selection and the
 * cross-credential project fan-out. Kept separate from railway.ts so this logic
 * is unit-testable without a database — the DB read lives in railway.ts and is
 * passed in here as plain data / an injected lister.
 */

import { toMessage } from "@alfred/contracts";
import {
  isRailwayAuthorizationError,
  type RailwayDeployment,
  type RailwayProject,
} from "@alfred/integrations/railway";
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
  const choices = credentials.map((c) => `${c.id} (${credentialLabel(c)})`).join(", ");
  throw new Error(
    `[railway.credentials] multiple Railway credentials connected — pass credentialId from list_projects (one of: ${choices})`,
  );
}

/**
 * Fan a project listing out across every connected credential, de-duped by
 * project id (first credential — newest-updated — wins) and tagged with its
 * provenance. An authorization failure on one credential is tolerated as long
 * as another *succeeds* (even with zero projects); a non-authz error always
 * propagates, and with a single credential the original error is surfaced
 * verbatim so the boss can ask the user to reconnect.
 */
export async function listProjectsForCredentials(
  credentials: ActiveBearerCredential[],
  listProjects: (token: string) => Promise<{ projects: RailwayProject[] }>,
): Promise<{ projects: RailwayProjectWithCredential[]; failures: RailwayFanoutFailure[] }> {
  const projectsById = new Map<string, RailwayProjectWithCredential>();
  const failures: RailwayFanoutFailure[] = [];
  let anySucceeded = false;
  for (const credential of credentials) {
    try {
      const result = await listProjects(credential.accessToken);
      anySucceeded = true;
      for (const project of result.projects) {
        if (!projectsById.has(project.id)) {
          projectsById.set(project.id, withCredential(project, credential));
        }
      }
    } catch (err) {
      if (!isRailwayAuthorizationError(err)) throw err;
      if (credentials.length === 1) throw err;
      failures.push({
        credentialId: credential.id,
        credentialLabel: credentialLabel(credential),
        message: toMessage(err),
      });
    }
  }
  // Only an *all-failed* fan-out is an error. A credential that succeeded with
  // zero projects (empty workspace) must not be reported as a failure.
  if (!anySucceeded && failures.length > 0) {
    throw new Error(
      `[railway.credentials] no Railway credential could list projects: ${failures
        .map((f) => `${f.credentialLabel}: ${f.message}`)
        .join("; ")}`,
    );
  }
  return { projects: [...projectsById.values()], failures };
}
