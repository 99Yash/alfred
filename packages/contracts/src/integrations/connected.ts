/** The connected rule (ADR-0093). Server and web both call it, so they agree on which rows count. */

import type { CredentialSpec } from "./registry";

/** The row fields the connected rule reads. */
export interface CredentialProofRow {
  readonly status: string;
  readonly scopes: Iterable<string>;
  /** `null` on a classic-OAuth GitHub row. */
  readonly installationId: string | null;
}

/** An empty `anyOfScopes` always passes. */
export function holdsAnyScope(granted: Iterable<string>, anyOfScopes: readonly string[]): boolean {
  if (anyOfScopes.length === 0) return true;

  for (const scope of granted) {
    if (anyOfScopes.includes(scope)) return true;
  }

  return false;
}

/**
 * Google checks scopes because the user can uncheck them at consent. GitHub checks
 * `installationId` because App permissions never reach `scopes`.
 */
export function credentialSatisfies(spec: CredentialSpec, row: CredentialProofRow): boolean {
  if (row.status !== "active") return false;

  switch (spec.shape) {
    case "google_oauth":
      return holdsAnyScope(row.scopes, spec.anyOfScopes);
    case "github_app":
      return row.installationId !== null;
    case "bearer":
      return true;
  }
}
