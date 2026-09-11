import {
  EVIDENCE_SNIPPET_MAX_CHARS,
  type EvidenceAnchor,
  type EvidenceCard,
  type EvidenceCitation,
  type EvidenceObjectRef,
} from "@alfred/contracts";
import type { ContextSourceReport } from "./search";

/**
 * The packer (#423; ADR-0101).
 *
 * `searchContext` returns canonical `EvidenceCard`s; the packer turns them
 * into the bounded text a model reads. It is the model-facing half of the
 * boundary, so it is deliberately the only place that decides how a card is
 * rendered, which cards fit the budget, and how honesty is preserved:
 *
 * - **Bounded.** The output never exceeds `maxChars`. Cards past the budget are
 *   dropped whole (never half a card) and counted in `omittedCount`, so a
 *   caller can say how much was left out instead of pretending the evidence was
 *   complete.
 * - **Cited.** Every card renders its source and any citations, anchors, and
 *   expansion handle it carries. A card with no citation still names its source
 *   in its header.
 * - **Honest.** A source that returned nothing or failed is reported by id;
 *   freshness is rendered per card and reads `unknown` when the source did not
 *   declare it, never inferred from a missing timestamp. A card's own `note`
 *   (degraded extraction, missing state) is preserved.
 *
 * It holds no adapters, calls no provider, and touches no database: pure
 * rendering over the contract, which is what makes it testable and keeps the
 * read boundary read-only.
 */

/** Characters in a packed result when the caller does not set a budget. */
export const EVIDENCE_PACK_DEFAULT_MAX_CHARS = 6_000;

/** Floor for a caller's budget, so a tiny budget cannot strip all attribution. */
export const EVIDENCE_PACK_MIN_MAX_CHARS = 500;

/** Ceiling for a caller's budget; a read that wants more asks again. */
export const EVIDENCE_PACK_MAX_MAX_CHARS = 24_000;

/** Cap on rendered per-source notes, so a wide source set stays bounded. */
const EVIDENCE_PACK_MAX_SOURCE_NOTES = 12;

/** Cap on one failed source's reason; the reason is provider text, not prose. */
const EVIDENCE_PACK_REASON_MAX_CHARS = 160;

/** Cap on a card's `note` in the packed output. */
const EVIDENCE_PACK_NOTE_MAX_CHARS = 500;

export interface PackEvidenceOptions {
  /**
   * The per-source reports from the read. Absence or a report is reported as a
   * missing note; a caller that omits reports packs only the cards.
   */
  readonly sources?: readonly ContextSourceReport[] | undefined;
  /** Hard character budget for the returned text. Clamped to the pack bounds. */
  readonly maxChars?: number | undefined;
}

export interface PackedEvidence {
  /** The bounded, model-facing text. Never longer than the effective budget. */
  readonly text: string;
  /** Ids of the cards that made it into `text`, in order. */
  readonly includedIds: readonly string[];
  /** Cards dropped because the budget bound. */
  readonly omittedCount: number;
  /** True when any card or note text was left out of `text`. */
  readonly truncated: boolean;
}

/**
 * Render cards as bounded, cited, honest model context.
 *
 * The notes section (failed/empty sources) is sized before the card loop, so
 * honesty never pushes the result past the budget: the loop reserves room for
 * the notes and stops early rather than letting them overflow. The final
 * `slice` is a backstop for a notes-only result, where no card is left to drop.
 */
export function packEvidenceCards(
  cards: readonly EvidenceCard[],
  options: PackEvidenceOptions = {},
): PackedEvidence {
  const maxChars = clampBudget(options.maxChars);
  const notes = renderSourceNotes(options.sources ?? []);
  const separator = "\n\n";
  const noteLength = notes.length > 0 ? notes.length + separator.length : 0;

  const blocks: string[] = [];
  let used = 0;

  for (const [index, card] of cards.entries()) {
    const block = renderCard(card, index + 1);
    const added = (blocks.length > 0 ? separator.length : 0) + block.length;

    if (used + added + noteLength > maxChars) break;

    blocks.push(block);
    used += added;
  }

  const sections = [...blocks];

  if (notes.length > 0) sections.push(notes);

  const joined = sections.length > 0 ? sections.join(separator) : "No evidence matched the query.";
  const text = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  const omittedCount = cards.length - blocks.length;

  return {
    text,
    includedIds: cards.slice(0, blocks.length).map((card) => card.id),
    omittedCount,
    truncated: omittedCount > 0 || text.length < joined.length,
  };
}

function clampBudget(requested: number | undefined): number {
  if (requested === undefined) return EVIDENCE_PACK_DEFAULT_MAX_CHARS;
  const integer = Math.trunc(requested);

  return Math.min(Math.max(integer, EVIDENCE_PACK_MIN_MAX_CHARS), EVIDENCE_PACK_MAX_MAX_CHARS);
}

/**
 * One line per source that could not contribute. `empty` and `error` are
 * distinct facts and render differently; a silently dropped source is the one
 * failure mode this exists to prevent.
 */
function renderSourceNotes(sources: readonly ContextSourceReport[]): string {
  const skipped = sources.filter((source) => source.status !== "ok");
  const shown = skipped.slice(0, EVIDENCE_PACK_MAX_SOURCE_NOTES);
  const hidden = skipped.length - shown.length;
  const lines = shown.map((source) => {
    if (source.status === "empty") return `${source.sourceId}: no evidence found`;
    const reason = source.reason
      ? ` (${truncate(source.reason, EVIDENCE_PACK_REASON_MAX_CHARS)})`
      : "";

    return `${source.sourceId}: unavailable${reason}`;
  });

  if (hidden > 0) lines.push(`+ ${hidden} more source(s) reported no usable evidence`);

  return lines.length > 0 ? `Source notes:\n${lines.join("\n")}` : "";
}

function renderCard(card: EvidenceCard, position: number): string {
  // An unnamed source (a bare MCP server) cites its stable id once, never twice.
  const source = card.source.displayName
    ? `${card.source.displayName} [${card.source.id}]`
    : card.source.id;
  const domain = card.source.domain ? ` — ${card.source.domain}` : "";
  const lines = [`[${position}] ${source} (${card.source.kind}, ${card.mediaKind})${domain}`];

  if (card.snippet !== undefined) {
    lines.push(`Content: ${truncate(card.snippet, EVIDENCE_SNIPPET_MAX_CHARS)}`);
  }

  if (card.object !== undefined) lines.push(`Object: ${renderObject(card.object)}`);

  if (card.entities !== undefined && card.entities.length > 0) {
    lines.push(
      `Entities: ${card.entities
        .map((entity) => `${entity.kind}=${entity.display ?? entity.value}`)
        .join("; ")}`,
    );
  }

  lines.push(`Time: ${renderTime(card)}`);

  if (card.authority !== undefined) {
    const label = card.authority.label ? ` — ${card.authority.label}` : "";

    lines.push(`Authority: ${card.authority.level}${label}`);
  }

  if (card.citations !== undefined && card.citations.length > 0) {
    lines.push(`Citations: ${card.citations.map(renderCitation).join("; ")}`);
  }

  if (card.anchors !== undefined && card.anchors.length > 0) {
    lines.push(`Anchors: ${card.anchors.map(renderAnchor).join("; ")}`);
  }

  if (card.expansion !== undefined) {
    const hint = card.expansion.hint ? ` (${card.expansion.hint})` : "";

    lines.push(`Expand: ${card.expansion.kind} ${card.expansion.ref}${hint}`);
  }

  if (card.note !== undefined) {
    lines.push(`Note: ${truncate(card.note, EVIDENCE_PACK_NOTE_MAX_CHARS)}`);
  }

  return lines.join("\n");
}

function renderObject(object: EvidenceObjectRef): string {
  const state = object.nativeState ?? "state unknown";
  const category = object.stateCategory ?? "uncategorized";
  const title = object.title ? ` "${object.title}"` : "";
  const repo = object.repo ? ` [${object.repo}]` : "";
  const url = object.url ? ` <${object.url}>` : "";

  return `${object.provider}/${object.kind} ${state} (${category})${title}${repo}${url}`;
}

/**
 * Always emits a freshness reading, so the model never has to infer staleness
 * from a missing timestamp. Only instants the card actually carries are shown.
 */
function renderTime(card: EvidenceCard): string {
  const parts: string[] = [];

  if (card.time?.occurredAt !== undefined) parts.push(`occurred ${card.time.occurredAt}`);
  if (card.time?.observedAt !== undefined) parts.push(`observed ${card.time.observedAt}`);
  if (card.time?.indexedAt !== undefined) parts.push(`indexed ${card.time.indexedAt}`);
  parts.push(`freshness ${card.time?.freshness ?? "unknown"}`);

  return parts.join("; ");
}

function renderCitation(citation: EvidenceCitation): string {
  const locator = citation.locator ? ` (${citation.locator})` : "";
  const url = citation.url ? ` <${citation.url}>` : "";

  return `${citation.label}${locator}${url}`;
}

function renderAnchor(anchor: EvidenceAnchor): string {
  const parts: string[] = [anchor.kind];

  if (anchor.page !== undefined) parts.push(`page ${anchor.page}`);
  if (anchor.region !== undefined) {
    parts.push(
      `region ${anchor.region.x},${anchor.region.y} ${anchor.region.width}x${anchor.region.height}`,
    );
  }

  if (anchor.confidence !== undefined) parts.push(`confidence ${anchor.confidence}`);
  if (anchor.note !== undefined) parts.push(anchor.note);

  return parts.join(" ");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
