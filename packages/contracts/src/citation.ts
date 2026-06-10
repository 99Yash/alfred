/**
 * Shared citation contract (ADR-0054 / SEARCH-001). Zero Node deps — safe to
 * import from `apps/web`, `packages/db`, `packages/api`, and `packages/sync`.
 *
 * This generalizes the briefing reference model (ADR-0049,
 * `briefing-references.ts`) into one cross-surface provenance grammar so every
 * cited output — briefings, meeting prep, and future surfaces — shares a single
 * token format, a single resolver, and a single renderable entity shape rather
 * than minting one provenance system per output surface.
 *
 * The grammar: an opaque `[[<kind>:<id>]]` token in model prose resolves
 * against a caller-supplied entity map to a renderable citation. The `<id>`
 * may itself contain colons (e.g. `activity:github:pr:warden#999`); only the
 * first colon separates kind from id.
 */

import { z } from "zod";

// ─── Kind vocabulary ──────────────────────────────────────────────────────

/**
 * The closed set of citable source kinds across all surfaces. Briefing's
 * `BRIEFING_REFERENCE_KINDS` (`activity | meeting | email`) is a documented
 * subset of this — see the `satisfies` guard in `briefing.ts`. Meeting prep
 * adds `todo` and `memory` to cite open loops and confirmed facts.
 */
export const CITATION_KINDS = ["email", "meeting", "todo", "memory", "activity"] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];
export const citationKindSchema = z.enum(CITATION_KINDS);

const CITATION_KIND_SET: ReadonlySet<string> = new Set(CITATION_KINDS);

export function isCitationKind(value: string): value is CitationKind {
  return CITATION_KIND_SET.has(value);
}

// ─── Citation string (`<kind>:<id>`) ──────────────────────────────────────

export type Citation = `${CitationKind}:${string}`;

export interface ParsedCitation {
  kind: CitationKind;
  id: string;
  citation: Citation;
}

export function makeCitation(kind: CitationKind, id: string): Citation {
  return `${kind}:${id}` as Citation;
}

/** Parse a `<kind>:<id>` string; returns null for unknown kinds or empty ids. */
export function parseCitation(value: string): ParsedCitation | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id || !isCitationKind(kind)) return null;
  return { kind, id, citation: makeCitation(kind, id) };
}

// ─── Token grammar + resolver ──────────────────────────────────────────────

/**
 * Matches `[[<kind>:<id>]]` tokens. The id is greedy over non-bracket,
 * non-whitespace chars so embedded colons survive (`[[activity:github:pr:1]]`).
 * Stateful (`g` flag) — only use with `matchAll`, never `.test()`.
 */
export const CITATION_TOKEN_RE = /\[\[([a-z_]+):([^\]\s]+)\]\]/g;

export function rawCitationFromMatch(match: RegExpMatchArray): string {
  return `${match[1] ?? ""}:${match[2] ?? ""}`;
}

export type CitationSegment<E> = { kind: "text"; text: string } | { kind: "citation"; entity: E };

export interface ResolveCitationsResult<E> {
  segments: CitationSegment<E>[];
  resolved: Citation[];
  unresolved: string[];
}

/**
 * Expand prose into renderable segments: literal text spans plus `citation`
 * segments carrying the matched entity for every `[[<kind>:<id>]]` token that
 * maps into `entities`. Unknown tokens fall back to their inner `<kind>:<id>`
 * text and are recorded in `unresolved`.
 *
 * Generic over the entity type so each surface keeps its own renderable shape
 * (briefing carries `source`, meeting prep carries packet-field context) while
 * sharing one walk. The map is keyed by the citation string; callers may key
 * with any `Citation` subtype (e.g. briefing's `BriefingReference`).
 */
export function resolveCitations<E>(
  markdown: string,
  entities: ReadonlyMap<string, E>,
): ResolveCitationsResult<E> {
  const segments: CitationSegment<E>[] = [];
  const resolved: Citation[] = [];
  const unresolved: string[] = [];

  let cursor = 0;
  for (const match of markdown.matchAll(CITATION_TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: markdown.slice(cursor, start) });
    }

    const raw = rawCitationFromMatch(match);
    const parsed = parseCitation(raw);
    const entity = parsed ? entities.get(parsed.citation) : undefined;
    if (parsed && entity !== undefined) {
      segments.push({ kind: "citation", entity });
      resolved.push(parsed.citation);
    } else {
      segments.push({ kind: "text", text: raw });
      unresolved.push(raw);
    }

    cursor = start + match[0].length;
  }

  if (cursor < markdown.length) {
    segments.push({ kind: "text", text: markdown.slice(cursor) });
  }

  return { segments, resolved, unresolved };
}
