/**
 * API-key storage for an MCP connection, sent in a header or query parameter.
 * The key is stored sealed and opened once per request in `withApiKey`. Nothing caches it.
 */

import { mcpApiKeyPlacementSchema, redacted, type McpApiKeyPlacement } from "@alfred/contracts";
import { db } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { mcpApiKeyCredentials, mcpConnections } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { HostedEndpointError } from "../hosted-endpoint";
import type { McpApiKeyCredentialReader } from "./endpoint-authorization";

export interface PersistMcpApiKeyCredentialInput {
  connectionId: string;
  userId: string;
  placement: McpApiKeyPlacement;
  /** Plaintext; sealed before storage. */
  value: string;
}

/** The API-key reader for an owned connection, or `undefined` when it has no key. */
export async function readApiKeyAuthForConnection(
  connectionId: string,
  userId: string,
): Promise<McpApiKeyCredentialReader | undefined> {
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
    placement: async () => {
      const parsed = mcpApiKeyPlacementSchema.safeParse(row.placement);

      if (!parsed.success) {
        // An old row from before the name rule tightened. Throw a typed 4xx, not a 500.
        throw new HostedEndpointError(
          "invalid_placement",
          "The stored API-key placement is invalid. Remove and re-add the key.",
        );
      }

      return parsed.data;
    },
    secret: async () => redacted(credentialVault().open(row.secret)),
  };
}

/**
 * Seal and bind an API key in one transaction; a re-add replaces it in place.
 * Clears `credentialId`: a CHECK allows one credential pointer. The OAuth store clears the inverse.
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
