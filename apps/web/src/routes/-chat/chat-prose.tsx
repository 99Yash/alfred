import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";
import { CodeBlock, InlineCode } from "./code-block";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Fenced code → highlighted card; inline code keeps the chip styling. */
const COMPONENTS: Components = { pre: CodeBlock, code: InlineCode };

/**
 * Compact, muted markdown for the chat's *subordinate* prose surfaces — the
 * "Thinking…" reasoning block and the per-step narration lines. Both carry model
 * prose that may be plain text or full markdown (bold, lists, links, `---`
 * rules, fenced code / JSON), so both render through here instead of dumping the
 * raw string with its literal `**`, `-`, and `---` markers showing. Tighter
 * rhythm and dimmer ink than the final reply's `AssistantMarkdown` so it stays
 * visually beneath the answer, while still formatting what the model wrote.
 *
 * No streaming healer here (unlike `AssistantMarkdown`): these are short,
 * subordinate lines where a half-typed marker flashing for a frame doesn't
 * warrant the cost — matching how the reasoning block has always streamed.
 */
export function ChatProse({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-[13px] leading-relaxed text-app-fg-3",
        "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:my-0.5",
        "[&_code]:rounded [&_code]:bg-app-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]",
        "[&_strong]:font-semibold [&_strong]:text-app-fg-4",
        "[&_a]:text-app-purple-4 [&_a]:underline [&_a]:underline-offset-2",
        "[&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-app-fg-4",
        "[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-app-fg-4 [&_h3]:font-semibold [&_h3]:text-app-fg-4",
        "[&_hr]:my-2 [&_hr]:border-app-fg-a1",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-app-fg-a1 [&_blockquote]:pl-3",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
