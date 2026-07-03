import type { BriefingGather } from "@alfred/contracts";
import { useMemo } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { briefingMarkdownComponents, briefingRefsPlugin } from "./briefing-markdown";
import { briefingPlainText } from "./briefing-prose-utils";

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
