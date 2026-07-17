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
import { sql, type SQL } from "drizzle-orm";
import { customType, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { customAlphabet } from "nanoid";

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

/**
 * Minimum namespace-secret length, mirroring `ENTITY_ID_NAMESPACE`'s `serverEnv`
 * policy (`optionalLongSecret`, min 32). Enforced HERE — at the only API that
 * actually mints ids — because the env field is `optional` (P0 has no writer
 * yet), so nothing stops a future P1 caller from doing
 * `serverEnv().ENTITY_ID_NAMESPACE ?? ""` and silently shipping HMAC-with-a-
 * blank-key ids, which are no harder to guess than the raw SHA the HMAC exists
 * to avoid (D2). Fail closed at the chokepoint, not in every caller.
 */
const MIN_ENTITY_ID_SECRET_LENGTH = 32;

/**
 * Stable, content-addressed entity id (ADR-0067 D2). HMAC-keyed (NOT raw SHA:
 * emails/logins are guessable and these ids surface in client sync + logs),
 * derived from a single normalized hard identity + the user. Deterministic, so
 * a cold replay re-mints the same id; the canonical winner on merge is chosen
 * by anchor rank (see `identityAnchorRank`), never by re-hashing.
 *
 * `secret` is the server-held namespace key (from `serverEnv`); callers pass it
 * in so this stays a pure function and `@alfred/db` keeps no env dependency.
 * Throws on a blank/short secret so a missing or mis-wired `ENTITY_ID_NAMESPACE`
 * fails closed instead of minting guessable public ids. Never seed from display
 * name, kind, significance, or a random id.
 */
export function computeStableEntityId(
  secret: string,
  input: { userId: string; identityKind: IdentityKind; normalizedValue: string },
): string {
  // Validate and HMAC the SAME bytes: the prior check measured `secret.trim()`
  // but the digest below keyed off the raw `secret`, so a value with accidental
  // surrounding whitespace (a quoted `.env` line, ` abc… `) passed the length
  // gate yet silently produced a DIFFERENT digest than the trimmed value — i.e.
  // a stray space would remint every content-addressed `ent_*` id. Reject
  // surrounding whitespace outright (these ids are permanent; a misconfigured
  // namespace must fail loud, not normalize behind the operator's back) so the
  // raw `secret` HMAC'd below is provably the value that cleared validation.
  if (secret !== secret.trim() || secret.length < MIN_ENTITY_ID_SECRET_LENGTH) {
    throw new Error(
      `computeStableEntityId: namespace secret must be at least ${MIN_ENTITY_ID_SECRET_LENGTH} chars ` +
        `and free of surrounding whitespace (ENTITY_ID_NAMESPACE) — refusing to mint a guessable or ` +
        `whitespace-sensitive entity id.`,
    );
  }
  // The id inputs are as load-bearing as the secret. An empty or whitespace-
  // padded `userId`/`normalizedValue` would mint a deterministic `ent_*` anchor
  // that every "unknown" identity collapses onto — exactly the bad anchor that
  // merges unrelated identities forever. `identityRefSchema` enforces
  // `value.min(1)` at the app boundary, but this helper is the mint chokepoint
  // and is reached directly from `@alfred/db`, so fail closed here too. Reject
  // surrounding whitespace for the same reason as the secret: these ids are
  // permanent and must not be whitespace-sensitive (normalizing the value is
  // the caller's job, not ours to silently paper over).
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
  // The value must already be CANONICAL for its kind (lowercased email/domain/
  // github handle, etc.). The id is content-addressed from this exact string, so
  // `Person@x.com` and `person@x.com` would mint two permanent anchors for one
  // identity — the split-brain D2 exists to kill. Canonicalizing here is the
  // reducer's job (`canonicalizeIdentityValue`); the mint refuses a value that
  // isn't already canonical rather than fold it silently (same fail-loud posture
  // as the whitespace check — these ids are permanent, so a non-canonical anchor
  // must surface as a bug, not get normalized behind the caller's back).
  if (
    input.normalizedValue !== canonicalizeIdentityValue(input.identityKind, input.normalizedValue)
  ) {
    throw new Error(
      `computeStableEntityId: normalizedValue is not canonical for kind '${input.identityKind}' ` +
        `(expected '${canonicalizeIdentityValue(input.identityKind, input.normalizedValue)}') — ` +
        `refusing to mint a stable entity id from a non-canonical anchor.`,
    );
  }
  // The value must also be a legal FORMAT for its kind (a real email, a numeric
  // github id, an `owner/repo`, …). Canonical-but-malformed (`{ kind: "email",
  // value: "not-an-email" }`, `{ kind: "github_user_id", value: "abc" }`) would
  // otherwise mint a permanent `ent_*` anchor from garbage no later real value can
  // reconcile with. Mirror the `identityRefSchema` boundary refine here — this
  // helper is the mint chokepoint and is reached directly from `@alfred/db`.
  if (!identityValueMatchesKind(input.identityKind, input.normalizedValue)) {
    throw new Error(
      `computeStableEntityId: normalizedValue '${input.normalizedValue}' is not a valid format ` +
        `for kind '${input.identityKind}' — refusing to mint a stable entity id from a malformed identity.`,
    );
  }
  // Canonical, key-ordered JSON so the digest is stable across call sites.
  const canonicalInput: StableEntityIdInput = {
    v: STABLE_ENTITY_ID_VERSION,
    userId: input.userId,
    identityKind: input.identityKind,
    normalizedValue: input.normalizedValue,
  };
  const canonical = JSON.stringify(canonicalInput);
  const digest = createHmac("sha256", secret).update(canonical).digest();
  // 128 bits (~26 base32 chars) — ample collision resistance, compact id.
  return `ent_${base32(digest.subarray(0, 16))}`;
}

/**
 * Build an `entity_nodes` insert whose `id` is GUARANTEED to be the content
 * address of its `canonical_identity` (ADR-0067 D2). The two are stored in
 * independent columns and the DB id-shape CHECK only proves the id is
 * `ent_<base32>`-shaped — NOT that it was HMAC-derived from the stored identity.
 * Nothing else stops a writer from persisting an id minted from `a@x.com` next
 * to `canonicalIdentity: { value: "b@x.com" }`; a later cold replay re-derives
 * the id FROM the identity, computes a different `ent_*`, and silently orphans
 * every FK that bound to the old id — a permanent, spreading corruption of the
 * one surface the whole substrate keys on. The DB can't recompute the HMAC
 * (no secret), so the invariant can only be enforced at the write API: mint
 * both fields from ONE identity here, and a mismatched pair is unrepresentable.
 * Every `entity_nodes` writer (P1+) must go through this rather than hand-
 * assembling the row.
 *
 * `identity` is runtime-PARSED (`identityRefSchema`), not just trusted by its
 * TypeScript type: a coerced `unknown as IdentityRef` (e.g. a reducer reading a
 * provider payload through an `any`) could otherwise mint a node from a kind
 * outside `IDENTITY_KINDS` or a non-canonical value, and the DB id-shape CHECK
 * would not catch it. Parsing fails loud on a bad kind/value here, at the write
 * API, before a permanent id is minted.
 *
 * `firstSeenAt` is REQUIRED (not defaulted) and must be the earliest OBSERVATION
 * timestamp for this node — it is the merge-survivor tie-break (D2) read at the
 * fold, so it must be deterministic across replays. A wall-clock default (write/
 * replay time) would leak build time into merge ordering and break D13 replay
 * determinism, so the caller supplies the observation's `occurredAt` and the
 * write API makes it impossible to forget. (The column is NOT NULL with NO
 * DEFAULT, so a direct insert that bypasses this API and omits the field fails
 * LOUD rather than silently recording wall-clock time — which no P1+ writer is
 * allowed to do.)
 */
export function makeEntityNodeInsert(
  secret: string,
  userId: string,
  identity: IdentityRef,
  firstSeenAt: Date,
): { id: string; userId: string; canonicalIdentity: IdentityRef; firstSeenAt: Date } {
  const parsed = identityRefSchema.parse(identity);
  const id = computeStableEntityId(secret, {
    userId,
    identityKind: parsed.kind,
    normalizedValue: parsed.value,
  });
  return { id, userId, canonicalIdentity: parsed, firstSeenAt };
}

/**
 * Format a number with just enough precision to round-trip the float32
 * pgvector actually stores. Embedding providers return JS float64s, but
 * pgvector stores vector elements as float32, so 9 significant digits
 * (the round-trip width for float32) is sufficient — sending the full
 * float64 text only wastes bandwidth on writes and query literals.
 *
 * Not the minimal-length form (e.g. the float32 nearest 0.1 renders as
 * "0.100000001", not "0.1"), but trailing-zero trimming keeps it compact.
 */
export function formatFloat32(value: number): string {
  return Number(Math.fround(value).toPrecision(9)).toString();
}

export function formatVectorFloat32(values: number[]): string {
  return `[${values.map(formatFloat32).join(",")}]`;
}

/**
 * pgvector column wrapper. `toDriver` serializes `number[]` as a
 * float32-precision `[a,b,c]` literal pgvector accepts on insert;
 * `fromDriver` parses the same shape back so callers receive
 * `number[]` directly.
 *
 * All embeddings in alfred are 1024-dim (ADR-0021); use this helper
 * for any new vector column.
 */
export const vectorColumn = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return formatVectorFloat32(value);
    },
    fromDriver(value: string): number[] {
      return JSON.parse(value) as number[];
    },
  })(name);

// ---------------------------------------------------------------------------
// Embedding poison-pill guard
// ---------------------------------------------------------------------------

/**
 * How long a *transient or systemic* embed failure (a Voyage 5xx/429, a network
 * blip, a rotated key, a quota trip, a whole-provider outage) is tolerated
 * before the row is dead-lettered. Gated on the wall-clock age of the first
 * failure, NOT an attempt count: the embed sweep runs every ~5 minutes, so a
 * small attempt cap would be exhausted by a ~25-minute outage and permanently
 * drop the entire pending backlog (silent data loss). A full day gives the
 * provider (or ops) time to recover while still terminating the retry storm for
 * a genuinely un-embeddable input. Only a *per-input-permanent* error
 * (`PER_INPUT_PERMANENT_STATUSES`) dead-letters immediately regardless.
 *
 * Shared by every embeddable table (`documents`, `memory_chunks`) so the
 * poison-pill policy is defined once — see `buildEmbedFailureSet`.
 */
export const EMBED_RETRY_WINDOW_HOURS = 24;

/**
 * HTTP statuses that mean THIS specific input is un-embeddable — a malformed
 * request (400), a payload too large to embed (413), or content the provider
 * semantically rejects (422). Safe to dead-letter on the FIRST failure: the
 * same input will fail forever, so retrying only burns sweeps.
 *
 * Every OTHER non-`retryable` status is systemic and recoverable, NOT per-input:
 * a rotated-then-valid key (401), a quota/billing/permission trip (403), an
 * endpoint change (404), or a request timeout (408) return the same status for
 * every row while the condition lasts, then clear. Classifying those as
 * "permanent" would dead-letter the entire pending backlog on the first sweep
 * of a 20-minute key-rotation lag — the exact irreversible-loss class this
 * guard exists to prevent — so they ride the wall-clock window
 * (`EMBED_RETRY_WINDOW_HOURS`) instead. (429 and 5xx are already `retryable`
 * and never reach this set.)
 */
const PER_INPUT_PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/** Cap the persisted failure message; `HttpError` bodies are already bounded + redacted. */
const MAX_EMBED_ERROR_CHARS = 500;

/** Drizzle columns the embed poison-pill guard reads/stamps on the row it's recording against. */
export interface EmbedFailureColumns {
  attempts: AnyPgColumn;
  firstFailedAt: AnyPgColumn;
  failedAt: AnyPgColumn;
}

/**
 * Build the drizzle `.set(...)` payload that records an embed failure and
 * enforces the poison-pill dead-letter policy — the single source of truth
 * shared across every embeddable table (`documents`, `memory_chunks`), so a
 * change to the window, the redaction cap, or the transient/permanent
 * classification is one edit, not N co-varying copies.
 *
 * A per-input-permanent error (`PER_INPUT_PERMANENT_STATUSES` — the input
 * itself is un-embeddable) dead-letters the row (`failedAt`) immediately;
 * every other failure, INCLUDING a systemic 4xx (401/403/404 — a rotated key,
 * a quota trip, an endpoint change), rides the wall-clock window and only
 * dead-letters once the *first* failure is older than `EMBED_RETRY_WINDOW_HOURS`.
 * `attempts` still counts every failure for diagnostics but no longer gates
 * dead-lettering. Every `sql` expression references the row's PRE-update column
 * values (Postgres evaluates the SET list against the old row), so the
 * `COALESCE(firstFailedAt, now())` first-stamp and the CASE window behave as
 * described no matter how many sweeps have already hit the row.
 *
 * The returned keys are the drizzle property names shared by both tables
 * (`embedAttempts` / `embedFirstFailedAt` / `lastEmbedError` / `embedFailedAt`);
 * the keyed `satisfies` below excess-checks them in-helper so a stray or
 * renamed key is a compile error, not a column that silently never writes.
 * Table-specific concerns (userId scoping, empty-content terminal cases) stay
 * with the caller.
 */
export function buildEmbedFailureSet(cols: EmbedFailureColumns, err: unknown) {
  const permanent = isHttpError(err) && PER_INPUT_PERMANENT_STATUSES.has(err.status);
  return {
    embedAttempts: sql`${cols.attempts} + 1`,
    // Stamp the first failure once so the transient gate can measure how long
    // the failure has persisted (references the pre-update value).
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
 * The `.set(...)` fields that clear a poison-pill failure streak, so the
 * wall-clock grace is measured PER failure-streak, not for the row's lifetime.
 * Merge into the successful-(re-)embed write (`{ embedding, ...EMBED_SUCCESS_RESET }`).
 *
 * Also the correct way to resurrect a dead-lettered row: nulling `embedFailedAt`
 * alone leaves a days-old `embedFirstFailedAt`, so the CASE above re-dead-letters
 * the row on its very first transient blip (`COALESCE(old, now()) <= now()-24h`
 * is already true). Clear both markers — this const — to genuinely revive it.
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
