import * as Tooltip from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "~/lib/utils";
import { altTextImageComponents } from "./alt-text-image";
import { markdownComponents } from "./elements";

import "katex/dist/katex.min.css";

// Shared fenced-code renderer, for surfaces with their own wrapper typography.
export { MarkdownPre } from "./markdown-pre";

export { CodeBlock } from "./code-block";

// Own module: a component file that also exports a plain function loses Fast Refresh.
export { altTextImageComponents } from "./alt-text-image";

type RemarkPlugins = ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

interface MarkdownRendererProps {
  children: string;
  className?: string | undefined;
  /**
   * `surface` follows theme tokens. `media` is fixed white-alpha for the rail's
   * weather video, which is always dark, so theme ink would invert against it.
   */
  tone?: "surface" | "media" | undefined;
  /**
   * `compact` (default) is the dense rail/email body; `reading` is the briefing scale.
   * Pick a variant, not a `className` font size: `text-[…]` ties on specificity.
   */
  size?: "compact" | "reading" | undefined;
  /** Runs after gfm/breaks/math. Briefings use it to turn `[[<kind>:<id>]]` into entity chips. */
  extraRemarkPlugins?: RemarkPlugins | undefined;
  /** Extra component overrides merged over the shared registry. */
  extraComponents?: Components | undefined;
  /**
   * `alt-text` prints the alt text and never emits `<img>`, so a tracker pixel
   * in untrusted content (inbox mail) makes no remote request.
   */
  images?: "render" | "alt-text" | undefined;
}

const SURFACE_TONE = [
  "text-app-fg-3",
  "[&_h1]:text-app-fg-4 [&_h2]:text-app-fg-4 [&_h3]:text-app-fg-4 [&_h4]:text-app-fg-4",
  "[&_strong]:text-app-fg-4",
  "[&_a]:text-app-purple-4 hover:[&_a]:text-app-purple-3",
  "[&_ul]:marker:text-app-fg-2 [&_ol]:marker:text-app-fg-2",
  "[&_blockquote]:border-app-bg-3/60 [&_blockquote]:text-app-fg-2",
  "[&_:not(pre)>code]:bg-app-bg-a2 [&_:not(pre)>code]:text-app-fg-4",
  "[&_th]:border-app-bg-3/40 [&_th]:text-app-fg-4 [&_td]:border-app-bg-3/40",
  "[&_hr]:border-app-bg-3/60",
] as const;

/** Literal link color: the light-mode `--app-purple-4` fails AA on the dark video. */
const MEDIA_TONE = [
  "text-white/85",
  "[&_h1]:text-white [&_h2]:text-white [&_h3]:text-white [&_h4]:text-white",
  "[&_strong]:text-white",
  "[&_a]:text-app-purple-rail hover:[&_a]:text-white",
  "[&_ul]:marker:text-white/50 [&_ol]:marker:text-white/50",
  "[&_blockquote]:border-white/20 [&_blockquote]:text-white/65",
  "[&_:not(pre)>code]:bg-white/10 [&_:not(pre)>code]:text-white",
  "[&_th]:border-white/20 [&_th]:text-white [&_td]:border-white/20",
  "[&_hr]:border-white/20",
] as const;

const COMPACT_SIZE = [
  "text-[12.5px] leading-[1.6]",
  "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_h1]:text-[15px] [&_h1]:mt-3 [&_h1]:mb-1.5",
  "[&_h2]:text-[14px] [&_h2]:mt-3 [&_h2]:mb-1.5",
  "[&_h3]:text-[13px] [&_h3]:mt-2.5 [&_h3]:mb-1",
  "[&_h4]:text-[12.5px] [&_h4]:mt-2 [&_h4]:mb-1",
  "[&_ul]:my-2 [&_ul]:pl-4 [&_ol]:my-2 [&_ol]:pl-4",
  "[&_li]:my-0.5",
  "[&_blockquote]:my-2",
  "[&_:not(pre)>code]:text-[11.5px]",
  "[&_table]:my-2 [&_table]:text-[11.5px]",
  "[&_hr]:my-3",
  "[&_.katex-display]:my-2",
] as const;

const READING_SIZE = [
  "text-[15px] leading-7",
  "[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_h1]:text-[22px] [&_h1]:mt-6 [&_h1]:mb-3",
  "[&_h2]:text-[18px] [&_h2]:mt-5 [&_h2]:mb-2.5",
  "[&_h3]:text-[16px] [&_h3]:mt-4 [&_h3]:mb-2",
  "[&_h4]:text-[15px] [&_h4]:mt-3 [&_h4]:mb-1.5",
  "[&_ul]:my-3 [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:pl-5",
  "[&_li]:my-1",
  "[&_blockquote]:my-3",
  "[&_:not(pre)>code]:text-[13px]",
  "[&_table]:my-3 [&_table]:text-[13px]",
  "[&_hr]:my-6",
  "[&_.katex-display]:my-3",
] as const;

/**
 * Render email/note bodies, assistant messages, and briefing prose as markdown.
 * `remark-breaks` keeps the hard line breaks of `text/plain` Gmail bodies.
 */
export function MarkdownRenderer({
  children,
  className,
  tone = "surface",
  size = "compact",
  extraRemarkPlugins,
  extraComponents,
  images = "render",
}: MarkdownRendererProps) {
  // `alt-text` wins over `extraComponents`: it is a privacy guarantee, not a style.
  const components: Components = {
    ...markdownComponents,
    ...extraComponents,
    ...(images === "alt-text" ? altTextImageComponents(tone) : {}),
  };

  return (
    <div
      className={cn(
        ...(size === "reading" ? READING_SIZE : COMPACT_SIZE),
        "[&_strong]:font-semibold",
        "[&_em]:italic",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_a]:wrap-break-word",
        "[&_ol]:list-decimal [&_ul]:list-disc",
        "[&_li]:pl-0.5",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-3",
        // `anywhere` breaks a long token only when it cannot fit; `break-all` splits every token.
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px",
        "[&_:not(pre)>code]:font-mono",
        "[&_:not(pre)>code]:[overflow-wrap:anywhere]",
        // display:block makes a wide table scroll instead of losing its columns.
        "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto",
        "[&_table]:border-collapse",
        "[&_th]:border [&_th]:px-1.5 [&_th]:py-1 [&_th]:font-medium",
        "[&_td]:border [&_td]:px-1.5 [&_td]:py-1",
        "[&_td]:wrap-break-word [&_th]:wrap-break-word",
        "[&_hr]:border-t",
        // Cap width so a large image cannot widen the rail.
        "[&_img]:h-auto [&_img]:max-w-full [&_img]:rounded",
        "[&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden",
        "[&_.katex]:text-[1em]",
        // `min-w-0` lets the flex parent shrink us, so a long URL cannot force the card open.
        "min-w-0 [overflow-wrap:anywhere] wrap-break-word",
        ...(tone === "media" ? MEDIA_TONE : SURFACE_TONE),
        className,
      )}
    >
      <Tooltip.Provider delayDuration={200}>
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            remarkBreaks,
            // Single-dollar text math off: stray "$5" shouldn't become math.
            [remarkMath, { singleDollarTextMath: false }],
            ...(extraRemarkPlugins ?? []),
          ]}
          rehypePlugins={[rehypeKatex]}
          components={components}
        >
          {children}
        </ReactMarkdown>
      </Tooltip.Provider>
    </div>
  );
}
