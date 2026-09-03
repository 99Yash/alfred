/**
 * What one MCP connection asks its authorization server for, and whether only
 * a fresh consent screen can satisfy that ask.
 *
 * This is policy, and it lives beside the connection it reads. The HTTP route
 * (`packages/http/src/mcp.ts`) used to union the registry baseline with two
 * scope columns, decide when to force a consent, and pick the pending sentence
 * inline — three connection fields and the existence of a built-in scope
 * baseline, all known to a route whose job is the redirect. A second consent
 * door would have copied the block.
 */

import type { McpConnection, McpServer } from "@alfred/db/schemas";

import { builtInAuthorizationScopes } from "./built-ins";

/** The connection fields a consent decision reads. */
export type McpConsentConnection = Pick<McpConnection, "grantedScopes" | "requiredScopes"> & {
  readonly server: Pick<McpServer, "endpointUrl">;
};

export interface McpConsentAsk {
  /** Every scope to request, registry baseline first. */
  readonly scopes: readonly string[];
  /**
   * {@link scopes} as OAuth's space-delimited `scope` parameter, empty when
   * this connection asks for nothing.
   */
  readonly scope: string;
  /**
   * True when the authorize call must land on a consent screen: either the
   * caller demanded one, or the ask names a scope the stored grant lacks.
   */
  readonly forceReauthorization: boolean;
  /**
   * The sentence `/integrations` shows on the card while the consent is
   * pending. The card reads `lastError`, so this is the whole report.
   */
  readonly pendingMessage: string;
}

/**
 * Union the scopes this connection must request, and decide whether the
 * request needs a visible consent.
 *
 * **Why a baseline exists.** The remote server decides what its `tools/list`
 * contains from the token it is given, and GitHub's server HIDES a tool whose
 * scope the token lacks instead of failing the call. Both scope columns are
 * empty on a fresh row, so with no baseline a built-in asks for nothing,
 * GitHub issues a token with an empty scope, and the catalog comes back with
 * only the scope-free tools — one that cannot read a pull request. Nothing in
 * the protocol reports that shortfall, which is why the ask is pinned in the
 * registry (`BUILT_IN_REGISTRY[…].scopes`) instead of discovered.
 *
 * **Why the baseline is not stored.** It is derived from the endpoint on every
 * authorize, so widening it in code needs no row migration and no backfill,
 * and the two scope columns keep their one meaning: what this connection was
 * granted, and what its server demanded through an insufficient-scope
 * response. A runtime demand therefore still widens the next consent.
 *
 * **What `forceReauthorization` actually buys.** It is a belt, not the
 * mechanism. The SDK's `auth()` short-circuits only through its refresh
 * branch, and a GitHub `gho_` token carries no refresh token, so a GitHub
 * reconnect reaches the authorization server either way — and GitHub skips the
 * consent screen by itself when every scope asked for is already granted. For
 * a provider that DOES issue a refresh token, `auth()` would renew the narrow
 * token and never ask, so the flag is what makes "the ask exceeds the grant"
 * reach a consent screen at all.
 *
 * The comparison is against `grantedScopes`, which the callback writes from
 * the token response through `parseOAuthScopeList`. That parser accepts
 * GitHub's comma list; a whitespace-only split stored `repo,read:org` as ONE
 * opaque scope, and then `exceedsGrant` stayed true on every single connect.
 */
export function mcpConsentAsk(
  connection: McpConsentConnection,
  options: { readonly forced: boolean },
): McpConsentAsk {
  const scopes = [
    ...new Set([
      ...builtInAuthorizationScopes(connection.server.endpointUrl),
      ...connection.grantedScopes,
      ...connection.requiredScopes,
    ]),
  ];
  const exceedsGrant = scopes.some((scope) => !connection.grantedScopes.includes(scope));
  const forceReauthorization = options.forced || exceedsGrant;
  return {
    scopes,
    scope: scopes.join(" "),
    forceReauthorization,
    // Which sentence is true depends on whether a grant already exists, not on
    // which route asked: a widened baseline over a ready connection is an
    // additional-permissions prompt too.
    pendingMessage:
      forceReauthorization && connection.grantedScopes.length > 0
        ? "Additional permissions require your consent."
        : "Authorization is required to connect this MCP server.",
  };
}
