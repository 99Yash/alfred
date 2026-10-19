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
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth passes the adapter an untyped row payload; the bound keeps the caller's own row type.
function sealWrite<T extends Record<string, unknown>>(payload: T, vault: CredentialVault): T {
  let sealed = payload;

  for (const field of ACCOUNT_SECRET_FIELDS) {
    if (!(field in payload)) continue;
    const value = payload[field];

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Better Auth types the adapter payload loosely; only a string token field is sealed.
    if (typeof value !== "string") continue;
    // A copy, so the caller's payload keeps its plaintext. Only the value under `field` changes.
    sealed = { ...sealed, [field]: vault.seal(value) };
  }

  return sealed;
}

/** Open token fields on read. Plaintext throws: it means a row was never sealed. */
function openRow<T>(row: T, vault: CredentialVault): T {
  if (!isRecord(row)) return row;
  let opened = row;

  for (const field of ACCOUNT_SECRET_FIELDS) {
    if (!(field in row)) continue;
    const value = row[field];

    if (value === null || value === undefined) continue;
    // A copy, so the driver's row keeps its envelope. Only the value under `field` changes.
    opened = { ...opened, [field]: vault.open(value) };
  }

  return opened;
}

/** Open joined account rows. Uses the declared join, so another model's `accessToken` is not touched. */
function openJoined<T>(
  row: T,
  join: Parameters<AuthAdapter["findOne"]>[0]["join"],
  vault: CredentialVault,
): T {
  if (join === undefined || !(ACCOUNT_MODEL in join)) return row;

  if (!isRecord(row)) return row;

  if (!(ACCOUNT_MODEL in row)) return row;
  const joined = row[ACCOUNT_MODEL];

  // `one-to-one` yields an object, the other relation types yield an array.
  const resolved = Array.isArray(joined)
    ? joined.map((entry: unknown) => openRow(entry, vault))
    : openRow(joined, vault);

  // Only the account join value changes.
  return { ...row, [ACCOUNT_MODEL]: resolved };
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

/** `create` arguments. Only `data` depends on the row type, so restate that one field. */
type CreateArgs<T> = Omit<Parameters<AuthAdapter["create"]>[0], "data"> & { data: Omit<T, "id"> };

/**
 * Each generic member restates its own type parameters and passes them to `base`, so the
 * result keeps the caller's row type. `openRow` and `openJoined` return the type they get.
 */
function decorateOperations(base: WithoutTransaction, vault: CredentialVault): WithoutTransaction {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Better Auth's own bound on the created row; the caller names the real row type.
  const create = async <T extends Record<string, unknown>, R = T>(
    data: CreateArgs<T>,
  ): Promise<R> => {
    if (data.model !== ACCOUNT_MODEL) return base.create<T, R>(data);

    const result = await base.create<T, R>({
      ...data,
      data: sealWrite(data.data, vault),
    });

    return openRow(result, vault);
  };

  const findOne = async <T>(data: Parameters<AuthAdapter["findOne"]>[0]): Promise<T | null> => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findOne<T>(data);

    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    const result = await base.findOne<T>(data);
    const withJoins = openJoined(result, data.join, vault);

    return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
  };

  const findMany = async <T>(data: Parameters<AuthAdapter["findMany"]>[0]): Promise<T[]> => {
    if (data.model !== ACCOUNT_MODEL && !data.join) return base.findMany<T>(data);

    if (data.model === ACCOUNT_MODEL) rejectSealedWhere(data.where);
    const rows = await base.findMany<T>(data);

    return rows.map((row) => {
      const withJoins = openJoined(row, data.join, vault);

      return data.model === ACCOUNT_MODEL ? openRow(withJoins, vault) : withJoins;
    });
  };

  const update = async <T>(data: Parameters<AuthAdapter["update"]>[0]): Promise<T | null> => {
    if (data.model !== ACCOUNT_MODEL) return base.update<T>(data);
    rejectSealedWhere(data.where);
    const result = await base.update<T>({ ...data, update: sealWrite(data.update, vault) });

    return openRow(result, vault);
  };

  const updateMany: AuthAdapter["updateMany"] = async (data) => {
    if (data.model !== ACCOUNT_MODEL) return base.updateMany(data);
    rejectSealedWhere(data.where);

    // Returns a count, so there is nothing to open.
    return base.updateMany({ ...data, update: sealWrite(data.update, vault) });
  };

  const consumeOne = async <T>(
    data: Parameters<AuthAdapter["consumeOne"]>[0],
  ): Promise<T | null> => {
    if (data.model !== ACCOUNT_MODEL) return base.consumeOne<T>(data);
    rejectSealedWhere(data.where);
    const result = await base.consumeOne<T>(data);

    return openRow(result, vault);
  };

  // `set` can write token fields, so seal it. Incrementing a sealed field makes no sense: refuse it.
  const incrementOne = async <T>(
    data: Parameters<AuthAdapter["incrementOne"]>[0],
  ): Promise<T | null> => {
    if (data.model !== ACCOUNT_MODEL) return base.incrementOne<T>(data);
    rejectSealedWhere(data.where);

    for (const field of Object.keys(data.increment)) {
      if (isSealedField(field)) throw new CredentialVaultError("malformed_envelope");
    }

    const result = await base.incrementOne<T>({
      ...data,
      ...(data.set ? { set: sealWrite(data.set, vault) } : {}),
    });

    return openRow(result, vault);
  };

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
