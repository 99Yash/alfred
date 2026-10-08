import { createHmac } from "node:crypto";
import {
  canonicalizeIdentityValue,
  identityRefSchema,
  identityValueMatchesKind,
  isHttpError,
  redactSecrets,
  STABLE_ENTITY_ID_VERSION,
  toMessage,
  type IdentityKind,
  type IdentityRef,
  type StableEntityIdInput,
} from "@alfred/contracts";
import { is, sql, type SQL } from "drizzle-orm";
import { customType, PgTransaction, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { customAlphabet } from "nanoid";
import type { DbRoot, DbTransaction } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const lifecycle_dates = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`current_timestamp`)
    .$onUpdate(() => new Date()),
};

export function createId(prefix?: string, { length = 12, separator = "_" } = {}): string {
  const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", length)();

  return prefix ? `${prefix}${separator}${id}` : id;
}

/**
 * Render enum constants as a raw SQL list for `IN (...)`. Never pass user input.
 * Sorted, so reordering the source constant does not change the CHECK text
 * and make `check:constraint-snapshot` demand a no-op migration.
 */
export const inList = (values: readonly string[]): SQL =>
  sql.raw(
    [...values]
      .sort()
      .map((v) => `'${v}'`)
      .join(", "),
  );

/** Make a literal value safe inside LIKE/ILIKE. Escape `\` first, then `%` and `_`. */
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function generateRandomCode(length: number = 8) {
  return customAlphabet("123456789", length)();
}

// ---------------------------------------------------------------------------
// Stable entity id (ADR-0067 D2)
// ---------------------------------------------------------------------------

/** RFC 4648 base32 alphabet, lowercased (matches `createId`'s lowercase id shape). */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Encode bytes as lowercased, unpadded base32. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/** Same minimum as `ENTITY_ID_NAMESPACE`. That env field is optional, so the mint checks again. */
const MIN_ENTITY_ID_SECRET_LENGTH = 32;

/**
 * Mint the permanent `ent_*` id for one identity of one user (ADR-0067 D2).
 * HMAC, not plain SHA: emails and logins are guessable, and these ids reach the client.
 * Throws on bad input instead of fixing it, because a wrong id is permanent.
 */
export function computeStableEntityId(
  secret: string,
  input: { userId: string; identityKind: IdentityKind; normalizedValue: string },
): string {
  // A padded secret passes a trimmed length check but HMACs to different ids.
  if (secret !== secret.trim() || secret.length < MIN_ENTITY_ID_SECRET_LENGTH) {
    throw new Error(
      `computeStableEntityId: namespace secret must be at least ${MIN_ENTITY_ID_SECRET_LENGTH} chars ` +
        `and free of surrounding whitespace (ENTITY_ID_NAMESPACE) — refusing to mint a guessable or ` +
        `whitespace-sensitive entity id.`,
    );
  }

  // An empty input would mint one id that every unknown identity merges onto.
  for (const [field, value] of [
    ["userId", input.userId],
    ["normalizedValue", input.normalizedValue],
  ] as const) {
    if (!value || value !== value.trim()) {
      throw new Error(
        `computeStableEntityId: ${field} must be non-empty and free of surrounding whitespace ` +
          `— refusing to mint a stable entity id from a bad anchor.`,
      );
    }
  }

  // `Person@x.com` and `person@x.com` must not mint two ids. The caller canonicalizes.
  if (
    input.normalizedValue !== canonicalizeIdentityValue(input.identityKind, input.normalizedValue)
  ) {
    throw new Error(
      `computeStableEntityId: normalizedValue is not canonical for kind '${input.identityKind}' ` +
        `(expected '${canonicalizeIdentityValue(input.identityKind, input.normalizedValue)}') — ` +
        `refusing to mint a stable entity id from a non-canonical anchor.`,
    );
  }

  // A malformed value (email "not-an-email") mints an id no real value can match.
  if (!identityValueMatchesKind(input.identityKind, input.normalizedValue)) {
    throw new Error(
      `computeStableEntityId: normalizedValue '${input.normalizedValue}' is not a valid format ` +
        `for kind '${input.identityKind}' — refusing to mint a stable entity id from a malformed identity.`,
    );
  }

  // Fixed key order keeps the digest stable.
  const canonicalInput: StableEntityIdInput = {
    v: STABLE_ENTITY_ID_VERSION,
    userId: input.userId,
    identityKind: input.identityKind,
    normalizedValue: input.normalizedValue,
  };

  const canonical = JSON.stringify(canonicalInput);
  const digest = createHmac("sha256", secret).update(canonical).digest();

  // 128 bits, 26 base32 chars.
  return `ent_${base32(digest.subarray(0, 16))}`;
}

export interface EntityNodeInsert {
  id: string;
  userId: string;
  canonicalIdentity: IdentityRef;
  firstSeenAt: Date;
}

/**
 * Build an `entity_nodes` row whose `id` and `canonicalIdentity` come from one identity.
 * The DB cannot recheck the HMAC, so every writer must use this.
 * `firstSeenAt` is the earliest observation time, not now: merges break ties on it,
 * so it must not change on a replay.
 */
export function makeEntityNodeInsert(
  secret: string,
  userId: string,
  identity: IdentityRef,
  firstSeenAt: Date,
): EntityNodeInsert {
  const parsed = identityRefSchema.parse(identity);

  const id = computeStableEntityId(secret, {
    userId,
    identityKind: parsed.kind,
    normalizedValue: parsed.value,
  });

  return { id, userId, canonicalIdentity: parsed, firstSeenAt };
}

/** pgvector stores float32, so 9 significant digits are enough. More only wastes bytes. */
export function formatFloat32(value: number): string {
  return Number(Math.fround(value).toPrecision(9)).toString();
}

export function formatVectorFloat32(values: number[]): string {
  return `[${values.map(formatFloat32).join(",")}]`;
}

/** pgvector column that reads and writes `number[]`. */
export const vectorColumn = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return formatVectorFloat32(value);
    },
    fromDriver(value: string): number[] {
      // SAFETY: toDriver wrote this `[a,b,c]` literal, so it parses back to numbers.
      return JSON.parse(value) as number[];
    },
  })(name);

// ---------------------------------------------------------------------------
// Embedding poison-pill guard
// ---------------------------------------------------------------------------

/**
 * How long an embed failure retries before the row is dead-lettered.
 * Measured from the first failure, not by attempts, so a short provider outage
 * does not drop the whole backlog.
 */
export const EMBED_RETRY_WINDOW_HOURS = 24;

const MAX_EMBED_ERROR_CHARS = 500;

export interface EmbedFailureColumns {
  attempts: AnyPgColumn;
  firstFailedAt: AnyPgColumn;
  failedAt: AnyPgColumn;
}

/**
 * `.set(...)` payload for an embed failure on `documents` or `memory_chunks`.
 * A per-input-permanent error dead-letters the row now. Any other error
 * dead-letters it after `EMBED_RETRY_WINDOW_HOURS`.
 * The SQL reads the pre-update row, because Postgres evaluates SET against old values.
 */
export function buildEmbedFailureSet(cols: EmbedFailureColumns, err: unknown) {
  const permanent = isHttpError(err) && err.perInputPermanent;

  return {
    embedAttempts: sql`${cols.attempts} + 1`,
    embedFirstFailedAt: sql`COALESCE(${cols.firstFailedAt}, now())`,
    lastEmbedError: redactSecrets(toMessage(err)).slice(0, MAX_EMBED_ERROR_CHARS),
    embedFailedAt: permanent
      ? sql`COALESCE(${cols.failedAt}, now())`
      : sql`CASE WHEN COALESCE(${cols.firstFailedAt}, now()) <= now() - make_interval(hours => ${EMBED_RETRY_WINDOW_HOURS}) THEN COALESCE(${cols.failedAt}, now()) ELSE ${cols.failedAt} END`,
  } satisfies Record<
    "embedAttempts" | "embedFirstFailedAt" | "lastEmbedError" | "embedFailedAt",
    SQL | string
  >;
}

/**
 * `.set(...)` fields that end a failure streak. Spread them into the successful embed write.
 * To revive a dead-lettered row, clear all of them: with only `embedFailedAt` cleared,
 * the old `embedFirstFailedAt` dead-letters the row again on its next failure.
 */
export const EMBED_SUCCESS_RESET = {
  embedAttempts: 0,
  embedFirstFailedAt: null,
  embedFailedAt: null,
  lastEmbedError: null,
} satisfies Record<
  "embedAttempts" | "embedFirstFailedAt" | "embedFailedAt" | "lastEmbedError",
  number | null
>;

// ---------------------------------------------------------------------------
// Query-runner plumbing
// ---------------------------------------------------------------------------

/** The root client or an open transaction. Take this so a write can join the caller's transaction. */
export type DbRunner = DbRoot | DbTransaction;

/**
 * Transaction handles with a nested `runAtomic` body still running.
 * A nested body is a savepoint, and drizzle names savepoints by depth only.
 * Two concurrent bodies on one handle share that name, so one rollback can
 * silently undo the other's writes. This guard rejects the second body. It
 * cannot see other writes on the same handle, so do not overlap those either.
 * The root client is not guarded: each call opens its own transaction.
 */
const bodiesInFlight = new WeakSet<object>();

/**
 * run these database operations together;
 * if the callback throws, undo its database writes.
 */
export async function runAtomic<T>(
  runner: DbRunner,
  body: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const nested = is(runner, PgTransaction);

  if (nested) {
    if (bodiesInFlight.has(runner)) {
      throw new Error(
        "runAtomic: this transaction handle already has a nested body in flight. " +
          "Await one before starting the next, or fan out over separate root-client " +
          "transactions — overlapping bodies share a savepoint name and Postgres " +
          "discards one's writes silently.",
      );
    }

    bodiesInFlight.add(runner);
  }

  return runner.transaction(body).finally(() => {
    if (nested) bodiesInFlight.delete(runner);
  });
}

/** Unwrap the row from `INSERT ... RETURNING`. A missing row is a bug, so throw. */
export function requireRow<T>(row: T | undefined, op: string): T {
  if (row === undefined) throw new Error(`${op}: expected a returned row, got none`);

  return row;
}
