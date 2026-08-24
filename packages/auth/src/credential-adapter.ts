import {
  ACCOUNT_SECRET_FIELDS,
  credentialVault,
  CredentialVaultError,
  type AccountSecretField,
  type CredentialVault,
} from "@alfred/db/credential-vault";
import { isRecord } from "@alfred/contracts";
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
 * Why not Better Auth's own `account.encryptOAuthTokens` option: as of the
 * installed 1.6.25 its write path does not cover `id_token`, it does not
 * transparently decrypt general adapter reads (only the paths it knows about),
 * and it derives its key from the Better Auth application secret rather than the
 * separate credential KEK this vault requires.
 */

/**
 * Derived from `drizzleAdapter` rather than imported.
 *
 * `@better-auth/core/db/adapter` does export `DBAdapter` as of 1.6.25, but that
 * package is a transitive dependency of `better-auth` and not a dependency of
 * `@alfred/auth`, so importing from it would be a phantom dependency that a
 * hoisting change could break. Deriving from the value we actually pass costs
 * nothing and cannot drift from it.
 */
type AuthAdapterFactory = ReturnType<typeof drizzleAdapter>;
type AuthAdapter = ReturnType<AuthAdapterFactory>;

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
  if (!isRecord(row)) return row;
  const source = row;
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
  if (!isRecord(row)) return row;
  const source = row;
  if (!(ACCOUNT_MODEL in source)) return row;
  const joined = source[ACCOUNT_MODEL];
  // `one-to-one` yields an object, the other relation types yield an array.
  const resolved = Array.isArray(joined)
    ? joined.map((entry) => openRow(entry, vault))
    : openRow(joined, vault);
  return Object.assign({}, source, { [ACCOUNT_MODEL]: resolved });
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
 * What this decorator owes each adapter member.
 *
 * - `seal` — the member reads or writes a token value, so it needs
 *   `sealWrite` on the way down, `openRow` on the way back, or both.
 * - `guard-where` — the member never touches a token value but does take a
 *   `where`, so it needs `rejectSealedWhere` and nothing else. Filtering on a
 *   sealed column can never match, and for these members that surfaces as
 *   "deleted 0 rows" or "count 0" rather than an error.
 * - `inert` — no `where`, no row values. Nothing to do.
 */
type MemberDuty = "seal" | "guard-where" | "inert";

/**
 * Every member of the adapter, classified — and exhaustive by construction.
 *
 * This exists because the completeness of this boundary used to rest on a
 * spread plus a comment listing method names. A spread passes anything new
 * straight through, and better-auth proved the point: 1.6.25 added `consumeOne`
 * and `incrementOne`, both of which take a `where` and return a row, and both
 * crossed this seam undecorated while the comment above the spread still read as
 * complete.
 *
 * The `satisfies` is the enforcement, and it runs both ways. A release that adds
 * an adapter method fails the build here until someone classifies it; and once
 * classified as anything but `inert`, `DecoratedMember` below makes the build
 * fail again until an implementation exists. That is the difference between a
 * documented boundary and a checked one.
 */
const MEMBER_DUTIES = {
  create: "seal",
  findOne: "seal",
  findMany: "seal",
  update: "seal",
  updateMany: "seal",
  consumeOne: "seal",
  incrementOne: "seal",
  count: "guard-where",
  delete: "guard-where",
  deleteMany: "guard-where",
  id: "inert",
  createSchema: "inert",
  options: "inert",
} satisfies Record<keyof WithoutTransaction, MemberDuty>;

/** The members this module must supply an implementation for. */
type DecoratedMember = {
  [K in keyof typeof MEMBER_DUTIES]: (typeof MEMBER_DUTIES)[K] extends "inert" ? never : K;
}[keyof typeof MEMBER_DUTIES];

/**
 * Each decorated operation is written against the *instantiated* parameter type
 * and then asserted back to the generic member type.
 *
 * That assertion is unavoidable rather than lazy: `create`, `findOne`,
 * `findMany`, `update`, `delete`, `consumeOne`, and `incrementOne` are generic in
 * their row type, and TypeScript has no way to say "same signature, same type
 * parameter, one transform applied to the result". The alternative is to
 * re-declare seven generic signatures by hand,
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
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    const result = await base.findOne(data);
    const withJoins = openJoined(result, data.join, vault);
    return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
  }) as AuthAdapter["findOne"];

  const findMany = (async (data: Parameters<AuthAdapter["findMany"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findMany(data);
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
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

  /**
   * Added in better-auth 1.6.25. Deletes one row and returns it, which makes it
   * a read of token values as much as a delete — an undecorated pass-through
   * would hand Better Auth raw envelopes and it would use them as tokens.
   */
  const consumeOne = (async (data: Parameters<AuthAdapter["consumeOne"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.consumeOne(data);
    rejectSealedWhere(data.where);
    const result = await base.consumeOne(data);
    return openRow(result, vault);
  }) as AuthAdapter["consumeOne"];

  /**
   * Added in better-auth 1.6.25. Its `set` map writes absolute values in the
   * same atomic step as the increments, so it is a write path for token fields
   * and has to seal. `increment` itself is numeric; a sealed field holds a
   * string envelope, so incrementing one is incoherent rather than merely wrong
   * and is refused.
   */
  const incrementOne = (async (data: Parameters<AuthAdapter["incrementOne"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.incrementOne(data);
    rejectSealedWhere(data.where);
    for (const field of Object.keys(data.increment)) {
      if (isSealedField(field)) throw new CredentialVaultError("malformed_envelope");
    }
    const result = await base.incrementOne({
      ...data,
      ...(data.set ? { set: sealWrite(data.set, vault) } : {}),
    });
    return openRow(result, vault);
  }) as AuthAdapter["incrementOne"];

  /**
   * `count`, `delete`, and `deleteMany` never carry a token value, but they do
   * carry a `where`. A filter on a sealed column matches nothing, so without
   * this they would answer "0 rows" — a silent wrong answer of exactly the kind
   * `rejectSealedWhere` exists to prevent, just quieter than a failed sign-in.
   */
  const count: AuthAdapter["count"] = async (data) => {
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    return base.count(data);
  };

  const remove = (async (data: Parameters<AuthAdapter["delete"]>[0]) => {
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    return base.delete(data);
  }) as AuthAdapter["delete"];

  const deleteMany: AuthAdapter["deleteMany"] = async (data) => {
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    return base.deleteMany(data);
  };

  // Annotated, not inferred: the annotation is what makes a member classified
  // `seal` or `guard-where` above and then forgotten here a build failure.
  const decorated: Pick<WithoutTransaction, DecoratedMember> = {
    create,
    findOne,
    findMany,
    update,
    updateMany,
    consumeOne,
    incrementOne,
    count,
    delete: remove,
    deleteMany,
  };

  // `id`, `createSchema`, and `options` are the `inert` members and delegate.
  return { ...base, ...decorated };
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
        // drift-ok: Better-Auth adapter interface — its transaction wraps
        // db().transaction internally; not a Drizzle handle to run runAtomic on.
        adapter.transaction((trx) => callback(decorateOperations(trx, resolved) as typeof trx)),
    };
  };
}

export type { AuthAdapter, AuthAdapterFactory };
