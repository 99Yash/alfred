import { MarkdownRenderer } from "~/components/markdown-renderer";
import { useMarkdownImageMode } from "./published-transcript";

/**
 * Compact muted markdown for reasoning and narration, a preset over {@link MarkdownRenderer}.
 * The reply uses `AssistantMarkdown` instead, which also heals and animates while streaming.
 * Images follow {@link useMarkdownImageMode}: alt text on a published transcript.
 */
export function ChatProse({ children, className }: { children: string; className?: string }) {
  return (
    <MarkdownRenderer
      size="compact"
      tone="surface"
      className={className}
      images={useMarkdownImageMode()}
    >
      {children}
    </MarkdownRenderer>
  );
}
