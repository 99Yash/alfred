import { z } from "zod";

import { artifactContentSchema, artifactFormatSchema, artifactKindSchema } from "./artifacts";
import { isoDateTimeStringSchema } from "./iso-date-time";
import { slugBase } from "./slug";

/**
 * The PUBLICATION shapes for a shared chat thread (ADR-0102).
 *
 * These are deliberately NARROWER than the synced rows in `@alfred/sync` that
 * they are built from, and the narrowing is the security control. A shared
 * thread is world-readable by URL, so every field here had to earn its place by
 * being something the owner would knowingly publish. Anything omitted below is
 * omitted on purpose; read the notes before widening one.
 *
 * The redaction runs at WRITE time (`buildSharedThreadSnapshot`), so the
 * `shared_threads` row never stores the dropped fields at all. That is what
 * makes the control hold: a later bug in the public read path cannot leak a
 * column that does not exist.
 */

/**
 * A tool call as a visitor sees it: THAT Alfred ran a tool, never what it read.
 *
 * `argsPreview` and `resultPreview` are dropped. On this product those two
 * fields routinely hold raw Gmail message bodies, calendar attendee lists,
 * Drive file contents, and GitHub issue text — the private material the whole
 * assistant exists to read. Publishing the trail without them still shows the
 * work ("Searched email", "Read calendar"); publishing them would hand the
 * user's inbox to anyone holding the link.
 *
 * `connectNudge` is dropped too: it is a repair affordance for the owner, and a
 * visitor can neither act on it nor should learn which integrations are broken.
 */
export const sharedThreadToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  /** Keeps the trail interleaved with narration in publish order. */
  segmentIndex: z.number().int().nonnegative().default(0),
});

export type SharedThreadToolCall = z.infer<typeof sharedThreadToolCallSchema>;

/** A narration segment — prose Alfred wrote itself, so it publishes as-is. */
export const sharedThreadNarrationSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

export type SharedThreadNarration = z.infer<typeof sharedThreadNarrationSchema>;

/**
 * One published turn.
 *
 * Dropped against `syncedChatMessageSchema`, each for its own reason:
 *   - `userId` / `threadId` / `runId` — internal identifiers. A visitor needs
 *     none of them, and they let an outsider correlate several shared threads
 *     back to one account.
 *   - `usage` — token counts, model latency, and COST in microdollars. That is
 *     the owner's billing data, not part of the conversation.
 *   - `errorKind` — names Alfred's internal failure taxonomy. A failed turn
 *     still publishes (`status`) so the transcript is not silently doctored,
 *     but the taxonomy stays private.
 *   - `rowVersion` / `updatedAt` — Replicache bookkeeping with no reader here.
 *
 * `reasoning` is KEPT. It is the model's own thinking, it is already shown to
 * the owner in a collapsible section, and a shared thread that hides it
 * misrepresents how the answer was reached. It is nonetheless the field most
 * likely to quote private context verbatim, so the share dialog says in plain
 * words that reasoning is published.
 */
export const sharedThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  reasoning: z.string().nullable().default(null),
  reasoningMs: z.number().nullable().default(null),
  status: z.enum(["complete", "failed"]),
  toolCalls: z.array(sharedThreadToolCallSchema).nullable().default(null),
  narration: z.array(sharedThreadNarrationSchema).nullable().default(null),
  createdAt: isoDateTimeStringSchema,
});

export type SharedThreadMessage = z.infer<typeof sharedThreadMessageSchema>;

/**
 * A published artifact. Only `complete` artifacts are snapshotted, so there is
 * no `status` field: a half-written `generating` body and a failed `error` body
 * are both things the owner never chose to publish.
 *
 * Unlike Dimension — whose public page re-reads artifact bodies live from the
 * `artifacts` table by id, so a later edit silently rewrites an already-shared
 * page — the body is COPIED here at publish time and never re-read.
 */
export const sharedThreadArtifactSchema = z.object({
  id: z.string(),
  kind: artifactKindSchema,
  format: artifactFormatSchema.nullable().default(null),
  title: z.string(),
  content: artifactContentSchema.nullable().default(null),
  createdAt: isoDateTimeStringSchema,
});

export type SharedThreadArtifact = z.infer<typeof sharedThreadArtifactSchema>;

/** The body `GET /api/shared/:slug` returns to an unauthenticated visitor. */
export const sharedThreadPageSchema = z.object({
  urlSlug: z.string(),
  title: z.string(),
  messages: z.array(sharedThreadMessageSchema),
  artifacts: z.array(sharedThreadArtifactSchema),
  sharedAt: isoDateTimeStringSchema,
});

export type SharedThreadPage = z.infer<typeof sharedThreadPageSchema>;

/**
 * One row in the owner's list of live shares for a thread. Carries no snapshot
 * body: the dialog only needs to name the link, date it, and revoke it.
 */
export const sharedThreadSummarySchema = z.object({
  id: z.string(),
  urlSlug: z.string(),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  sharedAt: isoDateTimeStringSchema,
});

export type SharedThreadSummary = z.infer<typeof sharedThreadSummarySchema>;

/**
 * Random characters appended to every slug.
 *
 * The slug IS the read capability — there is no token and no second check — so
 * its entropy is the whole access control. 16 characters of the 32-symbol
 * alphabet below is 80 bits, which is not enumerable. Dimension uses 6
 * (`nanoid6`, ~30 bits); at that width an attacker can walk the space, so it is
 * not copied. Do not shorten this for prettier URLs.
 */
export const SHARED_THREAD_SLUG_SUFFIX_LENGTH = 16;

/** Lowercase alphanumerics minus `l`, `1`, `o`, `0` — unambiguous when read aloud or retyped. */
const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * Build `kebab-title-<random>` from a thread title and caller-supplied random
 * bytes. Randomness is injected rather than read here so this stays pure and
 * `@alfred/contracts` keeps no crypto dependency; the server passes
 * `crypto.getRandomValues`-backed bytes.
 *
 * The title half is cosmetic. It is truncated hard because a title can be long
 * and a URL should stay pasteable, and it falls back to `thread` when a title
 * has no alphanumerics at all (an emoji-only title, say) so the slug never
 * degenerates to a bare suffix with a leading dash.
 */
export function buildSharedThreadSlug(title: string, randomBytes: Uint8Array): string {
  if (randomBytes.length < SHARED_THREAD_SLUG_SUFFIX_LENGTH) {
    throw new Error(
      `buildSharedThreadSlug: need at least ${SHARED_THREAD_SLUG_SUFFIX_LENGTH} random bytes, got ${randomBytes.length}`,
    );
  }

  let suffix = "";

  for (let i = 0; i < SHARED_THREAD_SLUG_SUFFIX_LENGTH; i++) {
    // SAFETY: `i` is below the length checked above, and the modulo keeps the
    // index inside `SLUG_ALPHABET`.
    suffix += SLUG_ALPHABET[randomBytes[i]! % SLUG_ALPHABET.length];
  }

  return `${slugBase(title, "thread").slice(0, 48).replace(/-+$/, "") || "thread"}-${suffix}`;
}
