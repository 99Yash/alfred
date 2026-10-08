import { z } from "zod";

import { DOCUMENT_MARKDOWN_MAX } from "./artifacts";
import { isoDateTimeStringSchema } from "./iso-date-time";
import { slugBase } from "./slug";

/**
 * Public shapes for a shared thread (ADR-0102). Anyone with the URL can read it,
 * so these are narrower than the synced rows, and the narrowing is the security
 * control. Redaction runs at write time (`toSharedMessage`, `toSharedArtifact`),
 * so the row never stores a dropped field. Read the notes before you widen one.
 */

/**
 * That a tool ran, never what it read. `argsPreview` and `resultPreview` hold
 * mail bodies and file contents. `connectNudge` would show which integrations are broken.
 */
export const sharedThreadToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  /** Keeps tool calls interleaved with narration. */
  segmentIndex: z.number().int().nonnegative().default(0),
});

export type SharedThreadToolCall = z.infer<typeof sharedThreadToolCallSchema>;

/** Prose Alfred wrote, so it publishes as-is. */
export const sharedThreadNarrationSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

export type SharedThreadNarration = z.infer<typeof sharedThreadNarrationSchema>;

/**
 * Drops from `syncedChatMessageSchema`: ids (they link shares to one account),
 * `usage` (billing data), `errorKind` (internal), and sync bookkeeping.
 * Keeps `reasoning`, and the share dialog says so: it can quote private context.
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
  /** A count, never the files, so the transcript is honest. Defaulted for older rows. */
  attachmentCount: z.number().int().nonnegative().default(0),
  createdAt: isoDateTimeStringSchema,
});

export type SharedThreadMessage = z.infer<typeof sharedThreadMessageSchema>;

/**
 * Narrower than `artifactContentSchema` on purpose. `pages` publishes only a count:
 * its HTML is built from tool results. `external_file` has no variant: it points
 * into the owner's Drive, so `toSharedArtifact` drops it.
 */
export const sharedThreadArtifactBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), markdown: z.string().max(DOCUMENT_MARKDOWN_MAX) }),
  z.object({ kind: z.literal("pages"), pageCount: z.number().int().nonnegative().max(100) }),
]);

export type SharedThreadArtifactBody = z.infer<typeof sharedThreadArtifactBodySchema>;

/**
 * Only `complete` artifacts publish, so there is no `status`. The body is copied
 * at publish time, so a later edit does not change a shared page.
 */
export const sharedThreadArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: sharedThreadArtifactBodySchema,
  createdAt: isoDateTimeStringSchema,
});

export type SharedThreadArtifact = z.infer<typeof sharedThreadArtifactSchema>;

/** `GET /api/shared/:slug`, unauthenticated. */
export const sharedThreadPageSchema = z.object({
  urlSlug: z.string(),
  title: z.string(),
  messages: z.array(sharedThreadMessageSchema),
  artifacts: z.array(sharedThreadArtifactSchema),
  sharedAt: isoDateTimeStringSchema,
});

export type SharedThreadPage = z.infer<typeof sharedThreadPageSchema>;

/** One live share in the owner's list. No snapshot body. */
export const sharedThreadSummarySchema = z.object({
  id: z.string(),
  urlSlug: z.string(),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  sharedAt: isoDateTimeStringSchema,
});

export type SharedThreadSummary = z.infer<typeof sharedThreadSummarySchema>;

/** The slug is the only read check. 16 chars of 32 symbols is 80 bits. Do not shorten it. */
export const SHARED_THREAD_SLUG_SUFFIX_LENGTH = 16;

/** No `l`, `1`, `o`, or `0`, so it is easy to retype. */
const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * Build `kebab-title-<random>`. The caller passes the random bytes, so this stays pure.
 * The title part is cosmetic and falls back to `thread`.
 */
export function buildSharedThreadSlug(title: string, randomBytes: Uint8Array): string {
  if (randomBytes.length < SHARED_THREAD_SLUG_SUFFIX_LENGTH) {
    throw new Error(
      `buildSharedThreadSlug: need at least ${SHARED_THREAD_SLUG_SUFFIX_LENGTH} random bytes, got ${randomBytes.length}`,
    );
  }

  let suffix = "";

  for (let i = 0; i < SHARED_THREAD_SLUG_SUFFIX_LENGTH; i++) {
    // SAFETY: `i` is in range, and the modulo keeps the index inside `SLUG_ALPHABET`.
    suffix += SLUG_ALPHABET[randomBytes[i]! % SLUG_ALPHABET.length];
  }

  return `${slugBase(title, "thread").slice(0, 48).replace(/-+$/, "") || "thread"}-${suffix}`;
}
