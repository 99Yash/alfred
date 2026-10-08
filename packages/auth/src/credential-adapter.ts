import {
  ACCOUNT_SECRET_FIELDS,
  credentialVault,
  CredentialVaultError,
  type CredentialVault,
} from "@alfred/db/credential-vault";
import { enumGuard, isRecord } from "@alfred/contracts";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * Encrypts Better Auth's `account` tokens in the adapter, the only place that sees every
 * read and write (#453). Not `encryptOAuthTokens`: as of 1.6.25 it skipped `id_token`,
 * missed some reads, and used the auth secret instead of the KEK.
 */

/** Derived, not imported: `@better-auth/core` is only a transitive dependency. */
type AuthAdapterFactory = ReturnType<typeof drizzleAdapter>;

type AuthAdapter = ReturnType<AuthAdapterFactory>;

const ACCOUNT_MODEL = "account";

// One field list with the vault's boot gate. Two lists could drift apart.
const isSealedField = enumGuard(ACCOUNT_SECRET_FIELDS);

/** Seal token fields on write. Better Auth only writes plaintext it got from us or a provider. */
function sealWrite<T extends Record<string, unknown>>(payload: T, vault: CredentialVault): T {
  let sealed: Record<string, unknown> | undefined;

  for (const field of ACCOUNT_SECRET_FIELDS) {
    if (!(field in payload)) continue;
    const value = payload[field];

    if (typeof value !== "string") continue;
    sealed ??= { ...payload };
    sealed[field] = vault.seal(value);
  }

  // SAFETY: only field values change, not keys, so T's shape holds.
  return (sealed ?? payload) as T;
}

/** Open token fields on read. Plaintext throws: it means a row was never sealed. */
function openRow<T>(row: T, vault: CredentialVault): T {
  if (!isRecord(row)) return row;
  const source: Record<string, unknown> = row;
  let opened: Record<string, unknown> | undefined;

  for (const field of ACCOUNT_SECRET_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];

    if (value === null || value === undefined) continue;
    opened ??= { ...source };
    opened[field] = vault.open(value);
  }

  // SAFETY: only field values change, not keys, so T's shape holds.
  return (opened ?? source) as T;
}

/** Open joined account rows. Uses the declared join, so another model's `accessToken` is not touched. */
function openJoined<T>(
  row: T,
  join: Parameters<AuthAdapter["findOne"]>[0]["join"],
  vault: CredentialVault,
): T {
  if (join === undefined || !(ACCOUNT_MODEL in join)) return row;

  if (!isRecord(row)) return row;
  const source: Record<string, unknown> = row;

  if (!(ACCOUNT_MODEL in source)) return row;
  const joined = source[ACCOUNT_MODEL];

  // `one-to-one` yields an object, the other relation types yield an array.
  const resolved = Array.isArray(joined)
    ? joined.map((entry) => openRow(entry, vault))
    : openRow(joined, vault);

  // SAFETY: only the account join value changes, so T's shape holds.
  return Object.assign({}, source, { [ACCOUNT_MODEL]: resolved }) as T;
}

/** Reject a filter on a sealed column. Each envelope has a fresh nonce, so it would never match. */
function rejectSealedWhere(where: ReadonlyArray<{ field: string }> | undefined): void {
  if (!where) return;

  for (const clause of where) {
    if (isSealedField(clause.field)) throw new CredentialVaultError("malformed_envelope");
  }
}

type WithoutTransaction = Omit<AuthAdapter, "transaction">;

/** `seal`: touches token values. `guard-where`: only takes a `where`. `inert`: neither. */
type MemberDuty = "seal" | "guard-where" | "inert";

/**
 * Every adapter member, classified. A new Better Auth method fails the build here
 * until it is classified, and again until a non-`inert` one is implemented.
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

type DecoratedMember = {
  [K in keyof typeof MEMBER_DUTIES]: (typeof MEMBER_DUTIES)[K] extends "inert" ? never : K;
}[keyof typeof MEMBER_DUTIES];

/**
 * The generic members are cast back to their generic type. TypeScript cannot express
 * "same signature, transformed result" otherwise. `openRow` checks every value it opens.
 */
function decorateOperations(base: WithoutTransaction, vault: CredentialVault): WithoutTransaction {
  // SAFETY: forwards to base.create; only seals on the way in and opens on the way out.
  const create = (async (data: Parameters<AuthAdapter["create"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.create(data);

    const result = await base.create({
      ...data,
      data: sealWrite(data.data, vault),
    });

    return openRow(result, vault);
  }) as AuthAdapter["create"];

  // SAFETY: same seal/open forwarding as create.
  const findOne = (async (data: Parameters<AuthAdapter["findOne"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findOne(data);

    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    const result = await base.findOne(data);
    const withJoins = openJoined(result, data.join, vault);

    return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
  }) as AuthAdapter["findOne"];

  // SAFETY: same seal/open forwarding as findOne, mapped over rows.
  const findMany = (async (data: Parameters<AuthAdapter["findMany"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findMany(data);

    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    const rows = await base.findMany(data);

    return rows.map((row) => {
      const withJoins = openJoined(row, data.join, vault);

      return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
    });
  }) as AuthAdapter["findMany"];

  // SAFETY: same seal/open forwarding as create.
  const update = (async (data: Parameters<AuthAdapter["update"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.update(data);
    rejectSealedWhere(data.where);
    const result = await base.update({ ...data, update: sealWrite(data.update, vault) });

    return openRow(result, vault);
  }) as AuthAdapter["update"];

  const updateMany: AuthAdapter["updateMany"] = async (data) => {
    if (data.model !== ACCOUNT_MODEL) return base.updateMany(data);
    rejectSealedWhere(data.where);

    // Returns a count, so there is nothing to open.
    return base.updateMany({ ...data, update: sealWrite(data.update, vault) });
  };

  // SAFETY: returns the deleted row, so it opens like a read.
  const consumeOne = (async (data: Parameters<AuthAdapter["consumeOne"]>[0]) => {
    if (data.model !== ACCOUNT_MODEL) return base.consumeOne(data);
    rejectSealedWhere(data.where);
    const result = await base.consumeOne(data);

    return openRow(result, vault);
  }) as AuthAdapter["consumeOne"];

  // `set` can write token fields, so seal it. Incrementing a sealed field makes no sense: refuse it.
  // SAFETY: seals `set` on the way in, opens the row on the way out.
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

  // These take no token values, but a sealed `where` would silently answer 0 rows.
  const count: AuthAdapter["count"] = async (data) => {
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);

    return base.count(data);
  };

  const remove: AuthAdapter["delete"] = async (data) => {
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);

    return base.delete(data);
  };

  const deleteMany: AuthAdapter["deleteMany"] = async (data) => {
    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);

    return base.deleteMany(data);
  };

  // The annotation makes a classified but missing member a build error.
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

  // The `inert` members pass through.
  return { ...base, ...decorated };
}

/**
 * Wrap the adapter factory, not an instance: `betterAuth` builds its own instance from the factory.
 * @param vault For tests. Otherwise resolved on first use, so an import never needs a KEK.
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
      // Better Auth stores a new OAuth token inside a transaction, so wrap that handle too.
      transaction: (callback) =>
        // drift-ok: Better-Auth adapter interface — its transaction wraps
        // db().transaction internally; not a Drizzle handle to run runAtomic on.
        adapter.transaction((trx) => callback(decorateOperations(trx, resolved))),
    };
  };
}

export type { AuthAdapter, AuthAdapterFactory };
