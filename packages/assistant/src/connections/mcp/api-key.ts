/**
 * Owner-supplied API-key custody for a generic MCP connection.
 *
 * This is the third authentication variant after no-auth and OAuth (#1004): a
 * server that authenticates with one key placed in an explicit header or query
 * parameter. Like the OAuth grant, the connection row is the storage authority
 * and the secret uses the shared authenticated credential envelope — the plain
 * key exists only as a `SealedCredentialSecret` in
 * `mcp_api_key_credentials.secret`, and only ever as a local string for the one
 * request that opens it.
 *
 * `readApiKeyAuthForConnection` returns a reader rather than a value: the sealed
 * row is read once, the non-secret placement once with it, and the secret is
 * opened once per HTTP request inside `withApiKey`. Nothing caches an opened key.
 */

import { mcpApiKeyPlacementSchema, type McpApiKeyPlacement } from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { mcpApiKeyCredentials, mcpConnections } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import type { McpApiKeyAuth } from "./endpoint-authorization";

export interface PersistMcpApiKeyCredentialInput {
  connectionId: string;
  userId: string;
  /** Validated placement from the create route; stored non-secret. */
  placement: McpApiKeyPlacement;
  /** The plaintext key. Sealed in the same transaction that binds the row. */
  value: string;
}

/**
 * The API-key reader for one owned connection, or `undefined` when the
 * connection carries no key. The persisted placement is parsed here — the
 * database column stays `unknown` — so a malformed row fails at this boundary
 * rather than feeding the transport a guessed shape.
 */
export async function readApiKeyAuthForConnection(
  connectionId: string,
  userId: string,
): Promise<McpApiKeyAuth | undefined> {
  const [row] = await db()
    .select({
      placement: mcpApiKeyCredentials.placement,
      secret: mcpApiKeyCredentials.secret,
    })
    .from(mcpConnections)
    .innerJoin(
      mcpApiKeyCredentials,
      and(
        eq(mcpApiKeyCredentials.id, mcpConnections.apiKeyCredentialId),
        eq(mcpApiKeyCredentials.connectionId, mcpConnections.id),
        eq(mcpApiKeyCredentials.userId, mcpConnections.userId),
      ),
    )
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.userId, userId)))
    .limit(1);

  if (!row) return undefined;

  return {
    placement: async () => mcpApiKeyPlacementSchema.parse(row.placement),
    secret: async () => credentialVault().open(row.secret),
  };
}

/**
 * Seal and bind one API key to an owned connection, in one transaction. A
 * re-add replaces the stored key in place: the connection holds exactly one API
 * key credential, so an upsert on `connectionId` cannot orphan the old row.
 *
 * The bind also clears `credentialId`. The single-credential CHECK admits one
 * pointer, so a connection that arrives here holding an OAuth grant moves to
 * the key rather than violating the constraint. The orphaned OAuth row has no
 * reader once the pointer is gone, and the credential lifecycle retires it.
 * This store and the OAuth store are the two owners of the one-mode transition;
 * each clears the inverse pointer.
 */
export async function persistApiKeyCredential(
  input: PersistMcpApiKeyCredentialInput,
): Promise<void> {
  const secret = credentialVault().seal(input.value);

  await db().transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
      )
      .limit(1);

    if (!owned) throw new Error("MCP API-key connection does not belong to this user");

    const [credential] = await tx
      .insert(mcpApiKeyCredentials)
      .values({
        userId: input.userId,
        connectionId: input.connectionId,
        placement: input.placement,
        secret,
      })
      .onConflictDoUpdate({
        target: mcpApiKeyCredentials.connectionId,
        set: {
          placement: input.placement,
          secret,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!credential) throw new Error("MCP API-key upsert returned no row");

    await tx
      .update(mcpConnections)
      .set({ apiKeyCredentialId: credential.id, credentialId: null, updatedAt: new Date() })
      .where(
        and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
      );
  });
}
