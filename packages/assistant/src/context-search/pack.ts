import {
  evidenceObjectClosesAsk,
  EVIDENCE_SNIPPET_MAX_CHARS,
  sanitizeErrorMessage,
  type EvidenceAnchor,
  type EvidenceCard,
  type EvidenceCitation,
  type EvidenceObjectRef,
} from "@alfred/contracts";
import type { SourceExclusionReason } from "./manifest";
import type { ContextSearchResult, ContextSourceReport } from "./search";

/**
 * Render `EvidenceCard`s into bounded model text (ADR-0101). Pure: no provider, no DB.
 * - Never exceeds `maxChars`. Cards drop whole and count in `omittedCount`.
 * - Every card names its source. Failed, empty, skipped, and cut sources get a note.
 * - Freshness shows `unknown` when undeclared, never inferred from a missing time.
 * - Every model-facing string goes through `sanitizeErrorMessage`.
 */

export const EVIDENCE_PACK_DEFAULT_MAX_CHARS = 6_000;

/** A tiny budget must not strip all attribution. */
export const EVIDENCE_PACK_MIN_MAX_CHARS = 500;

export const EVIDENCE_PACK_MAX_MAX_CHARS = 24_000;

const EVIDENCE_PACK_MAX_SOURCE_NOTES = 12;

/** The reason is provider text. */
const EVIDENCE_PACK_REASON_MAX_CHARS = 160;

/** Model-facing words for each exclusion reason. */
const SKIPPED_NOTE = {
  unavailable: "temporarily unavailable",
  "no-answering-read": "not applicable to this question",
  // Must not read as "this source had nothing on the topic" (#1077).
  "expansion-only": "only re-reads records other sources found",
  // Each says the source was never asked, not that it found nothing (#1078).
  "over-budget": "costs more than this read pays for",
  "not-connected": "the account is not connected",
  "missing-scope": "the account has not granted access",
  "needs-reauth": "the account needs reconnecting",
} as const satisfies Record<SourceExclusionReason, string>;

const EVIDENCE_PACK_NOTE_MAX_CHARS = 500;

export interface PackEvidenceOptions {
  /** Clamped to the pack bounds. */
  readonly maxChars?: number | undefined;
}

export interface PackedEvidence {
  readonly text: string;
  readonly includedIds: readonly string[];
  /** Cards dropped by the budget or by the read's own `limit`. */
  readonly omittedCount: number;
  readonly truncated: boolean;
}

/**
 * Render a read result as bounded model context. The card loop reserves room
 * for the notes first, so notes never push the text over budget.
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

/** Pre-limit count. The gap to the card count is what `request.limit` dropped. */
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
 * One line per source whose evidence did not reach the text, including a
 * source that lost cards to `limit`. `error` lines go first, so the cap never
 * hides a failure behind a routine skip.
 */
function renderSourceNotes(
  sources: readonly ContextSourceReport[],
  evidence: readonly EvidenceCard[],
): RenderedNotes {
  const survivedBySource = new Map<string, number>();

  for (const card of evidence) {
    survivedBySource.set(card.source.id, (survivedBySource.get(card.source.id) ?? 0) + 1);
  }

  const urgent: string[] = [];
  const routine: string[] = [];

  for (const source of sources) {
    switch (source.status) {
      case "ok": {
        const survived = survivedBySource.get(source.sourceId) ?? 0;
        const dropped = source.evidenceCount - survived;

        if (dropped > 0) {
          routine.push(
            sourceNote(source.sourceId, `${dropped} item(s) not shown (evidence budget)`),
          );
        }

        break;
      }

      case "empty":
        routine.push(sourceNote(source.sourceId, "no evidence found"));
        break;
      case "skipped": {
        // "Not asked" differs from "found nothing" (#466). Closed enum, so no sanitizer.
        routine.push(sourceNote(source.sourceId, `not consulted (${SKIPPED_NOTE[source.reason]})`));
        break;
      }

      case "error": {
        const reason = source.reason
          ? ` (${sanitizeErrorMessage(source.reason, EVIDENCE_PACK_REASON_MAX_CHARS)})`
          : "";

        urgent.push(sourceNote(source.sourceId, `unavailable${reason}`));
        break;
      }

      default: {
        const _exhaustive: never = source;

        throw new Error(`[pack] unknown source status: ${String(_exhaustive)}`);
      }
    }
  }

  const lines = [...urgent, ...routine];
  const shown = lines.slice(0, EVIDENCE_PACK_MAX_SOURCE_NOTES);
  const hidden = lines.length - shown.length;

  if (hidden > 0) shown.push(`+ ${hidden} more source(s) with no shown evidence`);

  return {
    text: shown.length > 0 ? `Source notes:\n${shown.map(oneLine).join("\n")}` : "",
    hidden,
  };
}

function sourceNote(sourceId: string, suffix: string): string {
  return `${sourceId}: ${suffix}`;
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

  // An unnamed source (a bare MCP server) shows its id once.
  const source = card.source.displayName
    ? `${card.source.displayName} [${card.source.id}]`
    : card.source.id;

  const domain = card.source.domain ? ` — ${card.source.domain}` : "";
  const lines = [`[${position}] ${source} (${card.source.kind}, ${card.mediaKind})${domain}`];

  if (card.snippet !== undefined) {
    lines.push(`Content: ${bound(card.snippet, EVIDENCE_SNIPPET_MAX_CHARS)}`);
  }

  // The label carries the relation. Otherwise an email that names PR 42 renders
  // like the PR itself, and the model could cite it as proof of the PR's state.
  if (card.object !== undefined) {
    const label = card.object.relation === "is" ? "Object" : "Object named in this text";

    lines.push(`${label}: ${renderObject(card.object)}`);
  }

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

  return { text: lines.map(oneLine).join("\n"), truncated };
}

/**
 * One object reference, plus a "closed work" clause when its state closes an
 * open ask (#1089). Otherwise the model asks the user to finish shipped work.
 * - The clause names "this object", never a bare "this", which could mean the email.
 * - It stays on the same line as the state. `oneLine` removes newlines from
 *   provider fields such as a PR title, so they cannot split it off.
 * - It skips `bound()`: it is a short constant, and the packer measures whole cards.
 * `state delivered` dates the object, not the card, so it stays off the `Time:` line.
 */
function renderObject(object: EvidenceObjectRef): string {
  const state = object.nativeState ?? "state unknown";
  const category = object.stateCategory ?? "uncategorized";
  const delivered = object.stateDeliveredAt ? ` — state delivered ${object.stateDeliveredAt}` : "";
  const title = object.title ? ` "${object.title}"` : "";
  const repo = object.repo ? ` [${object.repo}]` : "";
  const url = object.url ? ` <${object.url}>` : "";
  const closing = evidenceObjectClosesAsk(object);
  const closed = closing ? ` — closed work: this object is ${closing}; it is not an open ask` : "";

  return oneLine(
    `${object.provider}/${object.kind} ${state} (${category})${delivered}${title}${repo}${url}${closed}`,
  );
}

/**
 * Fold a whole rendered line to one line: replace the four ECMAScript line
 * terminators, collapse space and tab runs, trim. Keep it narrow, not `\s+`:
 * `U+00A0` and `U+3000` are real provider typography.
 */
function oneLine(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Always emits freshness. Shows only the instants the card carries. */
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
  switch (anchor.kind) {
    case "page": {
      const extra = [
        ...(anchor.confidence !== undefined ? [`confidence ${anchor.confidence}`] : []),
        ...(anchor.note !== undefined ? [anchor.note] : []),
      ];

      return extra.length > 0 ? `page ${anchor.page} ${extra.join(" ")}` : `page ${anchor.page}`;
    }

    case "visual": {
      const parts = [
        `visual region ${anchor.region.x},${anchor.region.y} ${anchor.region.width}x${anchor.region.height}`,
        ...(anchor.confidence !== undefined ? [`confidence ${anchor.confidence}`] : []),
        ...(anchor.note !== undefined ? [anchor.note] : []),
      ];

      return parts.join(" ");
    }

    case "unknown": {
      const parts = [
        "unknown",
        ...(anchor.confidence !== undefined ? [`confidence ${anchor.confidence}`] : []),
        ...(anchor.note !== undefined ? [anchor.note] : []),
      ];

      return parts.join(" ");
    }

    default: {
      const _exhaustive: never = anchor;

      throw new Error(`[pack] unknown anchor kind: ${String(_exhaustive)}`);
    }
  }
}
