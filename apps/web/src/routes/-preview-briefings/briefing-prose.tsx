import { type BriefingGather, resolveBriefingReferences } from "@alfred/contracts";
import { useMemo } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { briefingMarkdownComponents, briefingRefsPlugin } from "./briefing-markdown";

/**
 * Resolve composer prose's `[[<kind>:<id>]]` tokens to their plain labels,
 * leaving the surrounding markdown intact. Resolved tokens become their label;
 * unresolved ones (or any token when no gather is present) fall back to their
 * inner id. Used by the no-gather render path below — markdown is preserved so
 * {@link MarkdownRenderer} still formats it. For a one-line plain gist (no
 * markdown markers) use {@link briefingGist}.
 */
export function briefingPlainText(markdown: string, gather: BriefingGather | null): string {
  if (!gather) return markdown.replace(/\[\[[a-z_]+:([^\]\s]+)\]\]/g, (_, id) => id);
  return resolveBriefingReferences(markdown, gather)
    .segments.map((segment) => (segment.kind === "text" ? segment.text : segment.label))
    .join("");
}

/**
 * Collapse composer prose to a single plain line for compact contexts like the
 * briefings-list gist. Resolves reference tokens (via {@link briefingPlainText})
 * and then strips the common markdown markers — headings, list bullets,
 * blockquotes, emphasis, inline code, link/image syntax — and squeezes
 * whitespace, so raw markdown never leaks into a one-line preview.
 */
export function briefingGist(markdown: string, gather: BriefingGather | null): string {
  return briefingPlainText(markdown, gather)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // ATX heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "") // list bullets / ordinals
    .replace(/(\*\*|__|~~|\*|_|`)/g, "") // emphasis / inline-code markers
    .replace(/\s+/g, " ") // collapse newlines + runs of whitespace
    .trim();
}

/**
 * Renders composer prose (`breaking_summary` or a section `body`) as real
 * markdown — headings, lists, emphasis, links — with the opaque
 * `[[<kind>:<id>]]` tokens resolved into inline entity chips against the row's
 * synced `gather` (ADR-0049). Resolution runs client-side through the shared
 * `@alfred/contracts` resolver — the same truth the server email renderer uses
 * — via a remark plugin, so chips sit naturally inside the rendered markdown
 * tree rather than splitting it. Without a gather (older rows, never-composed
 * slots) the prose still renders; tokens simply collapse to their inner label.
 */
export function BriefingProse({
  markdown,
  gather,
  size = "reading",
  className,
}: {
  markdown: string;
  gather: BriefingGather | null;
  size?: "compact" | "reading";
  className?: string;
}) {
  const remarkPlugins = useMemo(
    () => (gather ? [briefingRefsPlugin(gather)] : undefined),
    [gather],
  );
  // No gather → strip tokens to plain labels so raw `[[…]]` never reaches the page.
  const content = gather ? markdown : briefingPlainText(markdown, null);

  return (
    <MarkdownRenderer
      size={size}
      extraRemarkPlugins={remarkPlugins}
      extraComponents={briefingMarkdownComponents}
      className={className}
    >
      {content}
    </MarkdownRenderer>
  );
}
