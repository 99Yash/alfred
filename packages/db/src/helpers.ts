import { createHmac } from "node:crypto";
import {
  STABLE_ENTITY_ID_VERSION,
  type IdentityKind,
  type IdentityRef,
  type StableEntityIdInput,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { customType, timestamp } from "drizzle-orm/pg-core";
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
 */
export function makeEntityNodeInsert(
  secret: string,
  userId: string,
  identity: IdentityRef,
): { id: string; userId: string; canonicalIdentity: IdentityRef } {
  const id = computeStableEntityId(secret, {
    userId,
    identityKind: identity.kind,
    normalizedValue: identity.value,
  });
  return { id, userId, canonicalIdentity: identity };
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
