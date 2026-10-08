import { type BriefingGather, resolveBriefingReferences } from "@alfred/contracts";

/** Composer prose as plain text: resolved tokens become labels, others their inner id. */
export function briefingPlainText(markdown: string, gather: BriefingGather | null): string {
  if (!gather) return markdown.replace(/\[\[[a-z_]+:([^\]\s]+)\]\]/g, (_, id) => id);

  return resolveBriefingReferences(markdown, gather)
    .segments.map((segment) => (segment.kind === "text" ? segment.text : segment.label))
    .join("");
}
