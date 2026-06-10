/**
 * Briefing reference resolution (ADR-0049). Zero Node deps — the pure resolver
 * lives here so the web surface can expand the composer's opaque
 * `[[<kind>:<id>]]` tokens against a row's synced `gather` without importing
 * `@alfred/api` (web-boundary safe). Email's HTML renderer stays server-side in
 * `@alfred/api` but calls these same functions: one resolution truth, two
 * renderers.
 */

import {
  BRIEFING_REFERENCE_KINDS,
  type BriefingGather,
  type BriefingReferenceKind,
  type FullBriefingSection,
  type GatherSourceSlug,
} from "./briefing.js";
import { CITATION_TOKEN_RE, rawCitationFromMatch, resolveCitations } from "./citation.js";

export type BriefingReference = `${BriefingReferenceKind}:${string}`;

export interface BriefingReferenceOption {
  reference: BriefingReference;
  label: string;
  source: GatherSourceSlug;
}

export type BriefingSegment =
  | { kind: "text"; text: string }
  | {
      kind: "reference";
      reference: BriefingReference;
      referenceKind: BriefingReferenceKind;
      label: string;
      href?: string;
      source: GatherSourceSlug;
    };

export interface ResolveBriefingReferencesResult {
  segments: BriefingSegment[];
  resolved: BriefingReference[];
  unresolved: string[];
}

export interface ParsedBriefingReference {
  kind: BriefingReferenceKind;
  id: string;
  reference: BriefingReference;
}

interface ReferenceEntity {
  reference: BriefingReference;
  referenceKind: BriefingReferenceKind;
  label: string;
  href?: string;
  source: GatherSourceSlug;
}

const BRIEFING_REFERENCE_KIND_SET: ReadonlySet<string> = new Set(BRIEFING_REFERENCE_KINDS);

/**
 * Expand composer prose into renderable segments: literal text spans plus
 * resolved `reference` segments (carrying kind/label/href) for every
 * `[[<kind>:<id>]]` token that maps to a gather entity. Unknown tokens fall
 * back to their inner label as text and are recorded in `unresolved`.
 *
 * Delegates the token walk to the shared {@link resolveCitations} resolver
 * (ADR-0054) — one provenance walk across surfaces — then maps each citation
 * segment back into this surface's `reference` segment shape (carrying
 * `source`), keeping the briefing public API unchanged.
 */
export function resolveBriefingReferences(
  markdown: string,
  gather: BriefingGather,
): ResolveBriefingReferencesResult {
  const entities = buildReferenceEntityMap(gather);
  const result = resolveCitations(markdown, entities);
  return {
    segments: result.segments.map((segment) =>
      segment.kind === "text" ? segment : { kind: "reference", ...segment.entity },
    ),
    resolved: result.resolved as BriefingReference[],
    unresolved: result.unresolved,
  };
}

export function referencesFromSections(sections: FullBriefingSection[]): BriefingReference[] {
  const refs = new Set<BriefingReference>();
  for (const section of sections) {
    for (const reference of section.references ?? []) {
      const parsed = parseBriefingReference(reference);
      if (parsed) refs.add(parsed.reference);
    }
    for (const match of section.body.matchAll(CITATION_TOKEN_RE)) {
      const parsed = parseBriefingReference(rawCitationFromMatch(match));
      if (parsed) refs.add(parsed.reference);
    }
  }
  return [...refs];
}

export function listBriefingReferenceOptions(gather: BriefingGather): BriefingReferenceOption[] {
  return [...buildReferenceEntityMap(gather).values()].map(({ reference, label, source }) => ({
    reference,
    label,
    source,
  }));
}

/** Parse a `<kind>:<id>` reference string; returns null for unknown kinds or empty ids. */
export function parseBriefingReference(value: string): ParsedBriefingReference | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id || !isBriefingReferenceKind(kind)) return null;
  return { kind, id, reference: briefingReference(kind, id) };
}

export function isBriefingReferenceKind(value: string): value is BriefingReferenceKind {
  return BRIEFING_REFERENCE_KIND_SET.has(value);
}

export function briefingReference(kind: BriefingReferenceKind, id: string): BriefingReference {
  return `${kind}:${id}` as BriefingReference;
}

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function buildReferenceEntityMap(gather: BriefingGather): Map<BriefingReference, ReferenceEntity> {
  const entities = new Map<BriefingReference, ReferenceEntity>();

  for (const items of Object.values(gather.email.categories)) {
    for (const item of items ?? []) {
      const reference = briefingReference("email", item.documentId);
      entities.set(reference, {
        reference,
        referenceKind: "email",
        label: item.subject,
        source: "email",
        href: item.threadId ? gmailThreadUrl(item.threadId) : undefined,
      });
    }
  }

  for (const item of gather.integration_activity.items) {
    const reference = briefingReference("activity", item.id);
    entities.set(reference, {
      reference,
      referenceKind: "activity",
      label: item.title,
      source: "integration_activity",
      href: item.url,
    });
  }

  for (const event of gather.calendar?.events ?? []) {
    const reference = briefingReference("meeting", event.eventId);
    entities.set(reference, {
      reference,
      referenceKind: "meeting",
      label: event.title,
      source: "calendar",
    });
  }

  return entities;
}
