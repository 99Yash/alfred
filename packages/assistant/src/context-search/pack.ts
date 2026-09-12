import {
  EVIDENCE_SNIPPET_MAX_CHARS,
  sanitizeErrorMessage,
  type EvidenceAnchor,
  type EvidenceCard,
  type EvidenceCitation,
  type EvidenceObjectRef,
} from "@alfred/contracts";
import type { ContextSearchResult, ContextSourceReport } from "./search";

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
 * - **Honest.** The packer takes the whole read result, reports, not a bare
 *   card list, so failed and empty sources are structurally impossible to
 *   forget. A source that returned nothing or failed is reported by id; a
 *   productive source whose cards the read's own `limit` dropped entirely is
 *   reported by id with its dropped count, so a source that answered is never
 *   mistaken for one that was never consulted. Cards the read's `limit` dropped
 *   are counted; freshness is rendered per card and reads `unknown` when the
 *   source did not declare it, never inferred from a missing timestamp. A
 *   card's own `note` (degraded extraction, missing state) is preserved.
 *   `truncated` is true whenever any card, note, or source line was left out of
 *   `text`, including a render-cap cut.
 * - **Safe.** Every string that reaches the model goes through
 *   `sanitizeErrorMessage`, the repo's surrogate-safe bounded truncator, so a
 *   lone surrogate or NUL byte can never ride a snippet, a note, or a provider
 *   reason into the prompt.
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
  /** Hard character budget for the returned text. Clamped to the pack bounds. */
  readonly maxChars?: number | undefined;
}

export interface PackedEvidence {
  /** The bounded, model-facing text. Never longer than the effective budget. */
  readonly text: string;
  /** Ids of the cards that made it into `text`, in order. */
  readonly includedIds: readonly string[];
  /** Cards dropped by the budget or by the read's own `limit`. */
  readonly omittedCount: number;
  /** True when any card or note text was left out of `text`. */
  readonly truncated: boolean;
}

/**
 * Render a read result as bounded, cited, honest model context.
 *
 * The notes section (failed, empty, or fully-dropped sources) is sized before the card loop, so
 * honesty never pushes the result past the budget: the loop reserves room for
 * the notes and stops early rather than letting them overflow. The final
 * `sanitizeErrorMessage` is a backstop for a notes-only result, where no card
 * is left to drop.
 */
export function packEvidenceCards(
  result: Pick<ContextSearchResult, "evidence" | "sources">,
  options: PackEvidenceOptions = {},
): PackedEvidence {
  const maxChars = clampBudget(options.maxChars);
  const cards = result.evidence;
  const notes = renderSourceNotes(result.sources, cards);
  const separator = "\n\n";
  const noteLength = notes.text.length > 0 ? notes.text.length + separator.length : 0;

  const blocks: string[] = [];
  let used = 0;
  let cardTruncated = false;

  for (const [index, card] of cards.entries()) {
    const block = renderCard(card, index + 1);
    const added = (blocks.length > 0 ? separator.length : 0) + block.text.length;

    if (used + added + noteLength > maxChars) break;

    blocks.push(block.text);
    used += added;

    if (block.truncated) cardTruncated = true;
  }

  const sections = [...blocks];

  if (notes.text.length > 0) sections.push(notes.text);

  const joined = sections.length > 0 ? sections.join(separator) : "No evidence matched the query.";
  const text = sanitizeErrorMessage(joined, maxChars);
  const budgetOmitted = cards.length - blocks.length;
  const reported = totalReportedEvidence(result.sources);
  const limitOmitted = reported > cards.length ? reported - cards.length : 0;

  return {
    text,
    includedIds: cards.slice(0, blocks.length).map((card) => card.id),
    omittedCount: budgetOmitted + limitOmitted,
    truncated:
      budgetOmitted > 0 ||
      limitOmitted > 0 ||
      notes.hidden > 0 ||
      cardTruncated ||
      text.length < joined.length,
  };
}

/**
 * The source's own pre-limit count. `evidenceCount` is what the source returned,
 * not what survived `request.limit`, so the difference names the cards the read
 * dropped before the packer ever saw them.
 */
function totalReportedEvidence(sources: readonly ContextSourceReport[]): number {
  return sources.reduce((total, source) => total + source.evidenceCount, 0);
}

function clampBudget(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return EVIDENCE_PACK_DEFAULT_MAX_CHARS;
  }

  const integer = Math.trunc(requested);

  return Math.min(Math.max(integer, EVIDENCE_PACK_MIN_MAX_CHARS), EVIDENCE_PACK_MAX_MAX_CHARS);
}

interface RenderedNotes {
  readonly text: string;
  readonly hidden: number;
}

/**
 * One line per source whose evidence did not reach the packed text. `empty` and
 * `error` are distinct facts and render differently; a productive source whose
 * cards the read's `limit` dropped entirely is the third, and the one this
 * exists to prevent forgetting. The status switch is exhaustive on purpose: a
 * new status member becomes a compile error here rather than quietly rendering
 * as an error.
 *
 * "Dropped entirely" is judged on the cards the read handed the packer, before
 * the packer's own character budget: a card the packer omits for space still
 * proves the source answered, and the per-source budget that would attribute
 * that loss is #427.
 */
function renderSourceNotes(
  sources: readonly ContextSourceReport[],
  evidence: readonly EvidenceCard[],
): RenderedNotes {
  const representedSourceIds = new Set(evidence.map((card) => card.source.id));
  const lines: string[] = [];

  for (const source of sources) {
    switch (source.status) {
      case "ok":
        if (source.evidenceCount > 0 && !representedSourceIds.has(source.sourceId)) {
          lines.push(
            `${source.sourceId}: ${source.evidenceCount} item(s) not shown (evidence budget)`,
          );
        }

        break;
      case "empty":
        lines.push(`${source.sourceId}: no evidence found`);
        break;
      case "error": {
        const reason = source.reason
          ? ` (${sanitizeErrorMessage(source.reason, EVIDENCE_PACK_REASON_MAX_CHARS)})`
          : "";

        lines.push(`${source.sourceId}: unavailable${reason}`);
        break;
      }

      default: {
        const _exhaustive: never = source.status;

        throw new Error(`[pack] unknown source status: ${String(_exhaustive)}`);
      }
    }
  }

  const shown = lines.slice(0, EVIDENCE_PACK_MAX_SOURCE_NOTES);
  const hidden = lines.length - shown.length;

  if (hidden > 0) shown.push(`+ ${hidden} more source(s) with no shown evidence`);

  return { text: shown.length > 0 ? `Source notes:\n${shown.join("\n")}` : "", hidden };
}

interface RenderedCard {
  readonly text: string;
  readonly truncated: boolean;
}

function renderCard(card: EvidenceCard, position: number): RenderedCard {
  let truncated = false;

  const bound = (value: string, maxChars: number): string => {
    const clean = sanitizeErrorMessage(value);

    if (clean.length <= maxChars) return clean;

    truncated = true;

    return sanitizeErrorMessage(clean, maxChars);
  };

  // An unnamed source (a bare MCP server) cites its stable id once, never twice.
  const source = card.source.displayName
    ? `${card.source.displayName} [${card.source.id}]`
    : card.source.id;

  const domain = card.source.domain ? ` — ${card.source.domain}` : "";
  const lines = [`[${position}] ${source} (${card.source.kind}, ${card.mediaKind})${domain}`];

  if (card.snippet !== undefined) {
    lines.push(`Content: ${bound(card.snippet, EVIDENCE_SNIPPET_MAX_CHARS)}`);
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
    lines.push(`Note: ${bound(card.note, EVIDENCE_PACK_NOTE_MAX_CHARS)}`);
  }

  return { text: lines.join("\n"), truncated };
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
