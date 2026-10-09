/** The connected rule (ADR-0093). Server and web both call it, so they agree on which rows count. */

import type { ProviderAvailability } from "../integration-availability";
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

/** The row fields the account-selection rule reads. */
export type GithubAccountRow = Pick<ProviderAvailability, "installationId" | "accountLabel">;

/** A row that can mint a token *and* name the account, which is what a card and `@me` need. */
function isCompleteGithubAccount(row: GithubAccountRow): boolean {
  return row.installationId !== null && Boolean(row.accountLabel?.trim());
}

/**
 * The row that stands for "the user's GitHub account", from rows already in oldest-first
 * order. Installing the App on an org writes a second row beside the personal one, so
 * without one rule the Connected card and the tools can name different accounts. Callers
 * filter first — active, matching `accountRef`, or `credentialSatisfies` — and pass the rest.
 */
export function selectGithubAccountRow<Row extends GithubAccountRow>(
  rows: readonly Row[],
): Row | undefined {
  return (
    rows.find(isCompleteGithubAccount) ?? rows.find((row) => row.installationId !== null) ?? rows[0]
  );
}
