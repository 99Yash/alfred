import { MarkdownRenderer } from "~/components/markdown-renderer";

/**
 * Compact, muted markdown for the chat's *subordinate* prose surfaces — the
 * "Thinking…" reasoning block and the per-step narration lines. Both carry model
 * prose that may be plain text or full markdown (bold, lists, links, `---`
 * rules, fenced code / JSON), so both render through here instead of dumping the
 * raw string with its literal `**`, `-`, and `---` markers showing.
 *
 * This is a thin preset over the shared {@link MarkdownRenderer} (the same
 * renderer briefings, artifacts, and the inbox rail use) rather than a private
 * fork of the typography: it pins the `compact`/`surface` treatment so the
 * reasoning and narration lines stay visually beneath the final reply — dimmer
 * `app-fg-3` ink, tighter block rhythm, fenced code in the shared dark card.
 *
 * The final reply itself renders through `AssistantMarkdown`, which additionally
 * heals half-typed markdown and animates words in while streaming — cost these
 * short, subordinate lines don't warrant, matching how the reasoning block has
 * always streamed.
 */
export function ChatProse({ children, className }: { children: string; className?: string }) {
  return (
    <MarkdownRenderer size="compact" tone="surface" className={className}>
      {children}
    </MarkdownRenderer>
  );
}
