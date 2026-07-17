import { type BriefingGather, resolveBriefingReferences } from "@alfred/contracts";

/**
 * Resolve composer prose to a plain string (no chips, no markdown) — for
 * compact contexts like the briefings-list gist. Resolved tokens become their
 * label; unresolved ones (or any token when no gather is present) fall back to
 * their inner id.
 */
export function briefingPlainText(markdown: string, gather: BriefingGather | null): string {
  if (!gather) return markdown.replace(/\[\[[a-z_]+:([^\]\s]+)\]\]/g, (_, id) => id);
  return resolveBriefingReferences(markdown, gather)
    .segments.map((segment) => (segment.kind === "text" ? segment.text : segment.label))
    .join("");
}
