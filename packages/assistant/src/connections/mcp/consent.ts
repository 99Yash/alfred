/** Which scopes an MCP connection asks for, and whether it needs a fresh consent screen. */

import type { McpConnection, McpServer } from "@alfred/db/schemas";

import { builtInAuthorizationScopes } from "./built-ins";

/** The connection fields a consent decision reads. */
export type McpConsentConnection = Pick<McpConnection, "grantedScopes" | "requiredScopes"> & {
  readonly server: Pick<McpServer, "endpointUrl">;
};

export interface McpConsentAsk {
  /** Every scope to request, registry baseline first. */
  readonly scopes: readonly string[];
  /** {@link scopes} as the space-delimited OAuth `scope` parameter. */
  readonly scope: string;
  /** The caller forced consent, or the ask names a scope the grant lacks. */
  readonly forceReauthorization: boolean;
  /** Shown on the integrations card (via `lastError`) while consent is pending. */
  readonly pendingMessage: string;
}

/**
 * Union the registry baseline, granted, and demanded scopes.
 * The baseline is derived, not stored: servers hide tools the token lacks scope for.
 * Force consent when the ask exceeds the grant, or the SDK's `auth()` would just
 * refresh the narrow token and never ask.
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
    // Depends on whether a grant exists, not on which route asked.
    pendingMessage:
      forceReauthorization && connection.grantedScopes.length > 0
        ? "Additional permissions require your consent."
        : "Authorization is required to connect this MCP server.",
  };
}
