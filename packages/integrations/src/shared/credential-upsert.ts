import type {
  AccountPersona,
  CredentialProvider,
  CredentialStatus,
  JsonObject,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { credentialVault } from "@alfred/db/credential-vault";
import { integrationCredentials } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

/**
 * The one write path into `integration_credentials`. Package-private: `shared/index.ts` does not
 * export it, so a route goes through its provider's writer and that writer's required fields.
 */

/** How a reconnect writes `metadata`. The insert always writes the values as given. */
type CredentialMetadataWrite =
  | { readonly replace: JsonObject }
  /** Replace only `ownedKeys` and keep every other key (keys other writers own). */
  | { readonly ownedKeys: readonly string[]; readonly values: JsonObject };

export interface UpsertIntegrationCredentialArgs {
  userId: string;
  provider: CredentialProvider;
  accountId: string;
  accountLabel: string | null;
  accessToken: string;
  /** `null` writes NULL on a reconnect too. */
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  metadata: CredentialMetadataWrite;
  /** Written on the insert and on a reconnect. Omit to leave the column alone. */
  installationId?: string | undefined;
  /** Fills the column only when it is NULL on a reconnect. Omit to leave the column alone. */
  persona?: AccountPersona | null | undefined;
}

/** A connect and a reconnect both leave the row usable. */
const CONNECTED_STATUS: CredentialStatus = "active";

/**
 * A reconnect of the same `(userId, provider, accountId)` updates the row in place and resets
 * `status` to `active`. A different account always gets its own row.
 */
export async function upsertIntegrationCredential(
  args: UpsertIntegrationCredentialArgs,
  ex: ReturnType<typeof db> | DbTransaction = db(),
): Promise<{ id: string }> {
  const vault = credentialVault();
  // Seal once: each `seal` draws a fresh DEK and nonces.
  const sealedAccessToken = vault.seal(args.accessToken);
  const sealedRefreshToken = args.refreshToken === null ? null : vault.seal(args.refreshToken);
  const insertMetadata = "replace" in args.metadata ? args.metadata.replace : args.metadata.values;

  const updateSet: PgUpdateSetSource<typeof integrationCredentials> = {
    accessToken: sealedAccessToken,
    refreshToken: sealedRefreshToken,
    expiresAt: args.expiresAt,
    scopes: args.scopes,
    metadata: reconnectMetadata(args.metadata),
    status: CONNECTED_STATUS,
    accountLabel: args.accountLabel,
    lastRefreshedAt: new Date(),
    updatedAt: new Date(),
  };

  if (args.installationId !== undefined) {
    updateSet.installationId = args.installationId;
  }

  // Fill persona only when NULL, so a reconnect never overwrites a user override.
  if (args.persona !== undefined) {
    updateSet.persona = sql`COALESCE(${integrationCredentials.persona}, ${args.persona})`;
  }

  const result = await ex
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: args.provider,
      accountId: args.accountId,
      accountLabel: args.accountLabel,
      accessToken: sealedAccessToken,
      refreshToken: sealedRefreshToken,
      installationId: args.installationId ?? null,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      metadata: insertMetadata,
      status: CONNECTED_STATUS,
      persona: args.persona ?? null,
    })
    .onConflictDoUpdate({
      target: [
        integrationCredentials.userId,
        integrationCredentials.provider,
        integrationCredentials.accountId,
      ],
      set: updateSet,
    })
    .returning({ id: integrationCredentials.id });

  const row = result[0];

  if (!row) throw new Error(`[${args.provider}.credentials] upsert returned no row`);

  return { id: row.id };
}

function reconnectMetadata(write: CredentialMetadataWrite) {
  if ("replace" in write) return write.replace;

  const ownedKeys = sql.join(
    write.ownedKeys.map((key) => sql`${key}`),
    sql`, `,
  );

  return sql`(${integrationCredentials.metadata} - ARRAY[${ownedKeys}]::text[]) || ${JSON.stringify(write.values)}::jsonb`;
}
