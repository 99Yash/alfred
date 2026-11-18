import { z } from "zod";
import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
} from "./evidence-card";
import { objectIdentitySchema } from "./object-identity";

/**
 * What one read delivered, as the reader states it (ADR-0124 amendment 2026-11-18, the evidence
 * record). Each reader supplies its own references; the host adds the content hash. The record
 * keeps references and hashes, never content: the ids point to the raw record, and the hash shows
 * if an item changed after the read (memory.md section 6).
 */

/**
 * How much of an item the read delivered. `hit`: a title or a snippet, as a search returns it.
 * `body`: the item's content. A check job may cite a `body` read for the content, and a `hit`
 * only for the title or the snippet.
 */
export const READ_EVIDENCE_DEPTHS = ["hit", "body"] as const;

export type ReadEvidenceDepth = (typeof READ_EVIDENCE_DEPTHS)[number];

const readEvidenceDepthSchema = z.enum(READ_EVIDENCE_DEPTHS);

/** The longest version, store name, and item id that a reference keeps. */
export const READ_EVIDENCE_VERSION_MAX_CHARS = 200;

export const READ_EVIDENCE_STORE_MAX_CHARS = 100;

export const READ_EVIDENCE_ID_MAX_CHARS = 512;

/**
 * `sha256Canonical` of the item as the reader delivered it (memory.md section 7: a content hash of
 * each item read). A later read of the same item with another hash shows that the item changed.
 */
const readEvidenceHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A version, revision, or update time of the item, when the reader returns one. */
const readEvidenceVersionSchema = z.string().min(1).max(READ_EVIDENCE_VERSION_MAX_CHARS).optional();

export const readEvidenceRefSchema = z.discriminatedUnion("kind", [
  /**
   * A row in one of Alfred's stores. `store` is open: the reader names its own store
   * (`document`, `chat_message`, `todo`), and a new reader needs no schema change.
   */
  z
    .object({
      kind: z.literal("record"),
      store: z.string().min(1).max(READ_EVIDENCE_STORE_MAX_CHARS),
      id: z.string().min(1).max(READ_EVIDENCE_ID_MAX_CHARS),
      depth: readEvidenceDepthSchema,
      version: readEvidenceVersionSchema,
      hash: readEvidenceHashSchema,
    })
    .strict(),
  /** A provider object, by its `integration_objects` key (ADR-0062). */
  z
    .object({
      kind: z.literal("object"),
      object: objectIdentitySchema,
      depth: readEvidenceDepthSchema,
      version: readEvidenceVersionSchema,
      hash: readEvidenceHashSchema,
    })
    .strict(),
  /** A web page. The URL is whole: a cut URL does not resolve. */
  z
    .object({
      kind: z.literal("web"),
      url: z.string().min(1).max(EVIDENCE_CITATION_URL_MAX_CHARS),
      title: z.string().min(1).max(EVIDENCE_CITATION_LABEL_MAX_CHARS).optional(),
      depth: readEvidenceDepthSchema,
      hash: readEvidenceHashSchema,
    })
    .strict(),
]);

export type ReadEvidenceRef = z.infer<typeof readEvidenceRefSchema>;

/** A reference before the host hashes its item. A reader builds this, never the hash. */
export type ReadEvidenceRefDraft = ReadEvidenceRef extends infer R
  ? R extends ReadEvidenceRef
    ? Omit<R, "hash">
    : never
  : never;

/**
 * Where a read did not cover all that it matched. Absent means the reader states no gap.
 * `morePages`: a cursor or a flag says that more items exist. `truncated`: the reader cut an item
 * or the list. `returned` and `total` are counts when the reader knows them.
 */
export const readCoverageSchema = z
  .object({
    morePages: z.literal(true).optional(),
    truncated: z.literal(true).optional(),
    returned: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ReadCoverage = z.infer<typeof readCoverageSchema>;

/** The coverage of a reader whose only gap is a cut: `truncated` when `cut`, else no gap. */
export function truncatedCoverage(cut: boolean): ReadCoverage | undefined {
  return cut ? { truncated: true } : undefined;
}

/** The most references one read keeps. A larger read keeps the first ones and counts the rest. */
export const READ_EVIDENCE_REFS_MAX = 200;

/** One read's evidence: its references, the count left out, and its coverage gap. */
export const readEvidenceSchema = z
  .object({
    refs: z.array(readEvidenceRefSchema).max(READ_EVIDENCE_REFS_MAX),
    omittedRefs: z.number().int().positive().optional(),
    /** The web pages among `omittedRefs`, so a script's sources count them as omitted. */
    omittedPages: z.number().int().positive().optional(),
    coverage: readCoverageSchema.optional(),
  })
  .strict();

export type ReadEvidence = z.infer<typeof readEvidenceSchema>;

/**
 * Bound a reader's hashed references: keep the first {@link READ_EVIDENCE_REFS_MAX} that parse,
 * and count the rest. A reference that does not parse (an over-long URL) is left out and counted,
 * because a cut reference does not resolve. A reader calls the assistant's `itemEvidence`, which
 * hashes each item first.
 */
export function toReadEvidence(
  refs: readonly ReadEvidenceRef[],
  coverage?: ReadCoverage,
): ReadEvidence {
  const kept: ReadEvidenceRef[] = [];
  let omitted = 0;
  let omittedPages = 0;

  for (const ref of refs) {
    if (kept.length < READ_EVIDENCE_REFS_MAX && readEvidenceRefSchema.safeParse(ref).success) {
      kept.push(ref);
    } else {
      omitted += 1;

      if (ref.kind === "web") omittedPages += 1;
    }
  }

  const hasGap = coverage && Object.keys(coverage).length > 0;

  return {
    refs: kept,
    ...(omitted > 0 ? { omittedRefs: omitted } : {}),
    ...(omittedPages > 0 ? { omittedPages } : {}),
    ...(hasGap ? { coverage } : {}),
  };
}

/**
 * Why a script's host read did not execute (ADR-0124). The first five name a direct route or a
 * route change: `needs_approval`, the gate would show a card, and a script cannot show one;
 * `not_a_read`, no authority confirms the read; `binary_output`, the output is declared binary or
 * the response held bytes; `undeclared_output`, no trusted declaration says the output is
 * structured; `route_changed`, the broker refused the live route before delivery. `output_too_large`:
 * the value was above the host's delivery cap, so the guest did not get it. The rest are the
 * dispatch result kinds.
 */
export const HOST_READ_REFUSALS = [
  "needs_approval",
  "not_a_read",
  "binary_output",
  "undeclared_output",
  "route_changed",
  "output_too_large",
  "failed",
  "rejected",
  "blocked",
  "fenced",
  "invalid_input",
  "unknown_tool",
  "not_allowed",
  "feature_disabled",
] as const;

export type HostReadRefusal = (typeof HOST_READ_REFUSALS)[number];

/**
 * The outcome of one host call in the evidence record. `tool_error`: the read executed and
 * returned `ok: false` (an MCP `isError`, a provider failure that the tool reports in its value).
 * `unfinished`: the read had not settled when the script ended.
 */
export const HOST_CALL_OUTCOMES = [
  "executed",
  "tool_error",
  "unfinished",
  ...HOST_READ_REFUSALS,
] as const;

export type HostCallOutcome = (typeof HOST_CALL_OUTCOMES)[number];

/** The most web pages that a script's sources keep (ADR-0124 amendment 2026-11-18). */
export const SCRIPT_SOURCES_MAX = 20;

/** One web page that a script's reads returned. The shape of a `system.web_search` citation. */
export const scriptSourceSchema = z
  .object({
    url: z.string().min(1).max(EVIDENCE_CITATION_URL_MAX_CHARS),
    title: z.string().min(1).max(EVIDENCE_CITATION_LABEL_MAX_CHARS).optional(),
  })
  .strict();

export type ScriptSource = z.infer<typeof scriptSourceSchema>;

/**
 * The sources of one script, for the chat sources strip. The generic tool preview prunes long
 * arrays and long strings, so the UI reads this field, not the preview. `omitted` counts the pages
 * left out above the caps.
 */
export const scriptSourcesSchema = z
  .object({
    sources: z.array(scriptSourceSchema).max(SCRIPT_SOURCES_MAX),
    omitted: z.number().int().positive().optional(),
  })
  .strict();

export type ScriptSources = z.infer<typeof scriptSourcesSchema>;
