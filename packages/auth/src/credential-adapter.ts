import {
  ACCOUNT_SECRET_FIELDS,
  credentialVault,
  CredentialVaultError,
  type AccountSecretField,
  type CredentialVault,
} from "@alfred/db/credential-vault";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * Transparent encryption for Better Auth's `account` OAuth tokens (#453).
 *
 * Better Auth owns every read and write of that table, so there is no call site
 * in Alfred to wrap. The seam is the adapter: decorate it and the tokens are
 * sealed on the way to Postgres and opened on the way back, while Better Auth's
 * own OAuth refresh and account-linking code keeps seeing plaintext and needs no
 * change.
 *
 * Why not Better Auth's own `account.encryptOAuthTokens` option: in the
 * installed 1.6.9 its write path does not cover `id_token`, it does not
 * transparently decrypt general adapter reads (only the paths it knows about),
 * and it derives its key from the Better Auth application secret rather than the
 * separate credential KEK this vault requires.
 */

/**
 * Derived from `drizzleAdapter` rather than imported: better-auth 1.6.9 exports
 * `AdapterFactory` but not the `DBAdapter` instance type it produces, and
 * deriving both from the value we actually pass keeps this decorator correct
 * across a version bump instead of pinning a hand-copied shape.
 */
type AuthAdapterFactory = ReturnType<typeof drizzleAdapter>;
type AuthAdapter = ReturnType<AuthAdapterFactory>;
type AuthTransactionAdapter = Parameters<Parameters<AuthAdapter["transaction"]>[0]>[0];

/** The Better Auth model whose tokens are sealed. */
const ACCOUNT_MODEL = "account";
/**
 * `ACCOUNT_SECRET_FIELDS` comes from `@alfred/db/credential-vault` rather than
 * being restated here. The vault owns the column catalog, and its boot gate
 * refuses to start unless every field in that tuple is sealed, so the two lists
 * have to be the same list: a field only in this decorator is a column nothing
 * verifies, and a field only in the gate is a process that never boots again.
 * The Better Auth field names match the Drizzle schema keys, which is why one
 * tuple can serve both.
 */
function isSealedField(field: string): field is AccountSecretField {
  return (ACCOUNT_SECRET_FIELDS as readonly string[]).includes(field);
}

/**
 * Seal the token fields of an outbound write payload. Values are plaintext by
 * construction: everything Better Auth writes either came from a provider
 * response or from a row this decorator already opened.
 */
function sealWrite<T extends Record<string, unknown>>(payload: T, vault: CredentialVault): T {
  let sealed: Record<string, unknown> | undefined;
  for (const field of ACCOUNT_SECRET_FIELDS) {
    if (!(field in payload)) continue;
    const value = payload[field];
    if (typeof value !== "string") continue;
    sealed ??= { ...payload };
    sealed[field] = vault.seal(value);
  }
  return (sealed ?? payload) as T;
}

/**
 * Open the token fields of one row read back from Postgres.
 *
 * A non-envelope value throws rather than passing through. That is the whole
 * point of the invariant: a plaintext row means the backfill missed it, and
 * returning it would let the system keep working while quietly holding usable
 * tokens — the exact state this change exists to end.
 */
function openRow(row: unknown, vault: CredentialVault): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>;
  let opened: Record<string, unknown> | undefined;
  for (const field of ACCOUNT_SECRET_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === null || value === undefined) continue;
    opened ??= { ...source };
    opened[field] = vault.open(value);
  }
  return opened ?? row;
}

/**
 * Open account rows reached through a `join`, driven by the join option the
 * caller declared rather than by walking the result for keys that happen to be
 * named `accessToken`. A blind walk would decrypt — or reject — a coincidental
 * `accessToken` on some unrelated joined model.
 */
function openJoined(row: unknown, join: unknown, vault: CredentialVault): unknown {
  if (join === null || typeof join !== "object" || !(ACCOUNT_MODEL in join)) return row;
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>;
  if (!(ACCOUNT_MODEL in source)) return row;
  const joined = source[ACCOUNT_MODEL];
  // `one-to-one` yields an object, the other relation types yield an array.
  const resolved = Array.isArray(joined)
    ? joined.map((entry) => openRow(entry, vault))
    : openRow(joined, vault);
  return { ...source, [ACCOUNT_MODEL]: resolved };
}

/**
 * Reject a query that filters on a sealed column. Each envelope carries a fresh
 * nonce, so `where accessToken = <plaintext>` can never match and would return
 * "no such account" instead of failing — a silent wrong answer in the middle of
 * a sign-in. Better Auth does not issue such a query today; this makes sure a
 * future one is loud.
 */
function rejectSealedWhere(where: ReadonlyArray<{ field: string }> | undefined): void {
  if (!where) return;
  for (const clause of where) {
    if (isSealedField(clause.field)) throw new CredentialVaultError("malformed_envelope");
  }
}

type WithoutTransaction = Omit<AuthAdapter, "transaction">;

/**
 * Each decorated operation is written against the *instantiated* parameter type
 * and then asserted back to the generic member type.
 *
 * That assertion is unavoidable rather than lazy: `create`, `findOne`,
 * `findMany`, and `update` are generic in their row type, and TypeScript has no
 * way to say "same signature, same type parameter, one transform applied to the
 * result". The alternative is to re-declare four generic signatures by hand,
 * which is the parallel-shape duplication the repo bans and would silently rot
 * on a better-auth bump. The row transform is `unknown`-in / `unknown`-out and
 * validates every value it opens, so the runtime guarantee does not rest on the
 * assertion.
 */
function decorateOperations(base: WithoutTransaction, vault: CredentialVault): WithoutTransaction {
  const create = (async (data: Parameters<AuthAdapter["create"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.create(data);
    const result = await base.create({
      ...data,
      data: sealWrite(data.data, vault),
    });
    return openRow(result, vault);
  }) as AuthAdapter["create"];

  const findOne = (async (data: Parameters<AuthAdapter["findOne"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findOne(data);
    rejectSealedWhere(data.where);
    const result = await base.findOne(data);
    const withJoins = openJoined(result, data.join, vault);
    return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
  }) as AuthAdapter["findOne"];

  const findMany = (async (data: Parameters<AuthAdapter["findMany"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findMany(data);
    rejectSealedWhere(data.where);
    const rows = await base.findMany(data);
    return rows.map((row) => {
      const withJoins = openJoined(row, data.join, vault);
      return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
    });
  }) as AuthAdapter["findMany"];

  const update = (async (data: Parameters<AuthAdapter["update"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.update(data);
    rejectSealedWhere(data.where);
    const result = await base.update({ ...data, update: sealWrite(data.update, vault) });
    return openRow(result, vault);
  }) as AuthAdapter["update"];

  const updateMany: AuthAdapter["updateMany"] = async (data) => {
    if (data.model !== ACCOUNT_MODEL) return base.updateMany(data);
    rejectSealedWhere(data.where);
    // Returns a row count, so there is nothing to open on the way back.
    return base.updateMany({ ...data, update: sealWrite(data.update, vault) });
  };

  // `count`, `delete`, `deleteMany`, `id`, `createSchema`, and `options` never
  // carry a token value, so they delegate untouched.
  return { ...base, create, findOne, findMany, update, updateMany };
}

/**
 * Decorate a Better Auth adapter **factory** so both Alfred initializers get
 * the same boundary.
 *
 * The factory, not the resulting object: `betterAuth` calls the factory with
 * its own resolved options, so a decorator applied to an adapter instance would
 * be replaced by the instance Better Auth builds for itself.
 *
 * @param vault Injected in tests. Production resolves the singleton lazily, on
 *   the first `betterAuth` call, so importing this module never requires a KEK.
 */
export function encryptedAuthAdapter(
  base: AuthAdapterFactory,
  vault?: CredentialVault,
): AuthAdapterFactory {
  return (options) => {
    const resolved = vault ?? credentialVault();
    const adapter = base(options);
    const decorated = decorateOperations(adapter, resolved);
    return {
      ...decorated,
      // Recurse into the transaction handle. Better Auth links a social
      // account inside a transaction, so without this the one write that
      // actually stores a fresh OAuth token would bypass the boundary.
      transaction: (callback) =>
        adapter.transaction((trx) => callback(decorateOperations(trx, resolved) as typeof trx)),
    };
  };
}

export type { AuthAdapter, AuthAdapterFactory, AuthTransactionAdapter };
