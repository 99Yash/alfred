/**
 * MCP connections the user must repair (ADR-0100 amendment 2026-10-28, item 4). The banner, the
 * weekly sweep, and the briefing block read this beside the delivery-alert rule.
 *
 * A leaf on purpose: the connections barrel reaches it through `availability.ts`, and
 * `check:architecture` refuses a barrel that reaches `./client` or `./oauth`. So it reads the rows
 * itself and shares only the sealed-field list and the vault test with the OAuth provider.
 */

import {
  MCP_ALERT_ERROR_MAX,
  sanitizeErrorMessage,
  type McpConnectionAlert,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault, opensWithCurrentKey } from "@alfred/db/credential-vault";
import { mcpConnections, mcpOauthCredentials, mcpServers } from "@alfred/db/schemas";
import { and, asc, eq, ne } from "drizzle-orm";
import { mcpConsentAsk } from "./consent";

/** Sealed columns a read checks against the current KEK. */
export const SEALED_CREDENTIAL_FIELDS = [
  "clientSecret",
  "accessToken",
  "refreshToken",
  "idToken",
] as const;

/**
 * One alert per connection the user must repair, oldest first. Alertable: `auth_required`,
 * `failed`, or a sealed secret that does not open with the current key, even on a `ready` row,
 * because only a call finds that otherwise. `disconnected` is the user's own choice and stays
 * silent, like a deleted credential row.
 *
 * The alert carries facts, not a sentence: a model writes the words from them. The key test is
 * local: no network call, and no write. Any other vault fault throws.
 */
export async function readMcpConnectionAlerts(userId: string): Promise<McpConnectionAlert[]> {
  const rows = await db()
    .select({
      connectionId: mcpConnections.id,
      label: mcpConnections.label,
      status: mcpConnections.status,
      authServerIdentity: mcpConnections.authServerIdentity,
      grantedScopes: mcpConnections.grantedScopes,
      requiredScopes: mcpConnections.requiredScopes,
      lastError: mcpConnections.lastError,
      lastConnectedAt: mcpConnections.lastConnectedAt,
      endpointUrl: mcpServers.endpointUrl,
      clientSecret: mcpOauthCredentials.clientSecret,
      accessToken: mcpOauthCredentials.accessToken,
      refreshToken: mcpOauthCredentials.refreshToken,
      idToken: mcpOauthCredentials.idToken,
    })
    .from(mcpConnections)
    .innerJoin(
      mcpServers,
      and(eq(mcpServers.id, mcpConnections.serverId), eq(mcpServers.userId, mcpConnections.userId)),
    )
    // The provider's own join (`readForConnection` in `./oauth`), so both reads see one row.
    .leftJoin(
      mcpOauthCredentials,
      and(
        eq(mcpOauthCredentials.id, mcpConnections.credentialId),
        eq(mcpOauthCredentials.connectionId, mcpConnections.id),
        eq(mcpOauthCredentials.userId, mcpConnections.userId),
      ),
    )
    .where(and(eq(mcpConnections.userId, userId), ne(mcpConnections.status, "disconnected")))
    .orderBy(asc(mcpConnections.createdAt));

  const vault = credentialVault();

  return rows.flatMap((row): McpConnectionAlert[] => {
    const credentialUnopenable = !SEALED_CREDENTIAL_FIELDS.every((field) =>
      opensWithCurrentKey(vault, row[field]),
    );

    const alertable =
      row.status === "auth_required" || row.status === "failed" || credentialUnopenable;

    if (!alertable) return [];

    return [
      {
        connectionId: row.connectionId,
        label: row.label,
        status: row.status,
        credentialUnopenable,
        missingScopes: missingScopes(row),
        lastError:
          row.lastError === null ? null : sanitizeErrorMessage(row.lastError, MCP_ALERT_ERROR_MAX),
        lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
      },
    ];
  });
}

/**
 * The scopes a new consent would ask for that the grant lacks. Only an OAuth server has scopes;
 * an unauthenticated or API-key server reads as none.
 */
function missingScopes(row: {
  authServerIdentity: string | null;
  grantedScopes: string[];
  requiredScopes: string[];
  endpointUrl: string;
}): string[] {
  if (row.authServerIdentity === null) return [];

  const ask = mcpConsentAsk(
    {
      grantedScopes: row.grantedScopes,
      requiredScopes: row.requiredScopes,
      server: { endpointUrl: row.endpointUrl },
    },
    { forced: false },
  );

  return ask.scopes.filter((scope) => !row.grantedScopes.includes(scope));
}
