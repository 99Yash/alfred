import type { BriefingGather } from "@alfred/contracts";
import { useMemo } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { briefingMarkdownComponents, briefingRefsPlugin } from "./briefing-markdown";
import { briefingPlainText } from "./briefing-prose-utils";

/**
 * Composer prose as markdown, with `[[<kind>:<id>]]` tokens as entity chips (ADR-0049).
 * Uses the same contracts resolver as the email renderer.
 */
export function BriefingProse({
  markdown,
  gather,
  size = "reading",
  className,
}: {
  markdown: string;
  gather: BriefingGather | null;
  size?: "compact" | "reading" | undefined;
  className?: string | undefined;
}) {
  const remarkPlugins = useMemo(
    () => (gather ? [briefingRefsPlugin(gather)] : undefined),
    [gather],
  );

  // No gather: strip tokens to labels so raw `[[…]]` never shows.
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
