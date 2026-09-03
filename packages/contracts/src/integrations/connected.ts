/**
 * The connected rule (ADR-0093): a live provider is connected for a user when
 * one credential row satisfies the rule its `CredentialSpec` declares. The rule
 * is prose on each `CredentialSpec` member in `./types`; this is its one
 * executable home. The server's availability read and the web's connectedness
 * probe both call it, so the two cannot disagree on which rows count.
 */

import type { CredentialSpec } from "./types";

/**
 * The credential row fields the connected rule reads. The server's
 * `ProviderAvailability` (scopes as a `Set`) and the web's parsed credential
 * row (scopes as an array) both satisfy it.
 */
export interface CredentialProofRow {
  readonly status: string;
  readonly scopes: Iterable<string>;
  /** GitHub App installation id; `null` on every other shape and on a legacy classic-OAuth GitHub row. */
  readonly installationId: string | null;
}

/**
 * Whether a granted scope set holds at least one of `anyOfScopes`. An empty
 * requirement is satisfied by any grant: the caller had nothing to prove.
 */
export function holdsAnyScope(granted: Iterable<string>, anyOfScopes: readonly string[]): boolean {
  if (anyOfScopes.length === 0) return true;
  for (const scope of granted) {
    if (anyOfScopes.includes(scope)) return true;
  }
  return false;
}

/**
 * Whether one credential row proves its provider connected under `spec`. Every
 * shape needs an active row; what else it needs is the shape's rule:
 *
 * - `google_oauth`: the row holds one of `anyOfScopes`, because the consent
 *   screen lets the user uncheck scopes.
 * - `github_app`: the row carries an `installationId`, because App permissions
 *   never land in `scopes` and a classic-OAuth row cannot mint a token.
 * - `bearer`: the active row is the proof.
 *
 * A new shape is a new arm here, and an unhandled arm fails to compile.
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
