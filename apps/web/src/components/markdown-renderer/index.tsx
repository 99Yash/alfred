import * as Tooltip from "@radix-ui/react-tooltip";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "~/lib/utils";
import { markdownComponents } from "./elements";

import "katex/dist/katex.min.css";

interface MarkdownRendererProps {
  children: string;
  className?: string;
  /**
   * Color treatment. `surface` follows the app theme tokens — use it on
   * normal light/dark surfaces. `media` is FIXED white-alpha for content
   * that sits on the rail's weather video: that backdrop is always a dark
   * photograph regardless of theme, so theme tokens (near-black ink in
   * light mode) would invert against it. Mirrors how the rest of the rail
   * styles itself (`text-white/65`, `bg-white/[0.06]`, …).
   */
  tone?: "surface" | "media";
}

/** Theme-following colors for regular app surfaces. */
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

/**
 * Fixed white-alpha colors for the weather-video backdrop. Link color is a
 * literal (`--app-purple-4`'s dark-mode value) rather than the token — the
 * light-mode token (#918df6) drops below AA against the dark video.
 */
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

/**
 * Renders email/note bodies and assistant messages as markdown.
 *
 * Architecture mirrors dimension's renderer: a thin wrapper that owns the
 * shared typography (via the `[&_x]` selectors below) and a small `components`
 * registry (`./elements`) for tags that need behaviour — fenced code becomes a
 * dark `CodeBlock` with copy + syntax highlighting, and `"cite"`-titled links
 * become source pills. Everything else falls through to react-markdown's
 * defaults dressed by the tone selectors.
 *
 *  - `remark-gfm` handles GitHub-flavored extensions (tables, strikethrough,
 *    autolinks, task lists). Most plain-text email signatures + GitHub /
 *    Linear notification mails arrive in this dialect already.
 *  - `remark-breaks` turns single `\n` into `<br>`. Gmail bodies extracted
 *    from `text/plain` rely on hard line breaks, not paragraph spacing —
 *    without this they'd collapse into prose blocks.
 *  - `remark-math` + `rehype-katex` render `$$…$$` / `\(…\)` math. Single-`$`
 *    text math is disabled so stray dollar amounts ("$5") aren't parsed.
 */
export function MarkdownRenderer({ children, className, tone = "surface" }: MarkdownRendererProps) {
  return (
    <div
      className={cn(
        "text-[12.5px] leading-[1.6]",
        // Block spacing — tighter than `prose` defaults, which read as
        // "article" rather than "email body" at this scale.
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5",
        "[&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5",
        "[&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1",
        "[&_h4]:text-[12.5px] [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-1",
        // Inline text
        "[&_strong]:font-semibold",
        "[&_em]:italic",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_a]:break-words",
        // Lists
        "[&_ul]:my-2 [&_ul]:pl-4 [&_ul]:list-disc",
        "[&_ol]:my-2 [&_ol]:pl-4 [&_ol]:list-decimal",
        "[&_li]:my-0.5 [&_li]:pl-0.5",
        // Blockquote — typical "On X wrote:" reply chains land here once we
        // add the quote-detector. Until then this still tames the rare `>` line.
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:my-2",
        // Inline code — tokens like `useInfiniteQuery` and quoted file refs
        // (`chat-shell.tsx:450`) routinely exceed the rail width.
        // `overflow-wrap: anywhere` lets the browser break mid-token *only
        // when* a word boundary won't fit on the line — keeping single
        // identifiers intact whenever they have room. Avoid `break-all`,
        // which slices every long-ish token across lines even when it
        // would fit by simply wrapping onto the next row. Fenced ``` blocks
        // are handled by `CodeBlock` (the `pre` override) and aren't styled
        // here.
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px",
        "[&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[11.5px]",
        "[&_:not(pre)>code]:[overflow-wrap:anywhere]",
        // Tables — emails rarely contain them, but newsletters sometimes do.
        // Wrap the table in a horizontal scroller (display:block on the table
        // itself) so wide tables stay tabular rather than collapsing column
        // structure. Body cells still wrap their text.
        "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto",
        "[&_table]:border-collapse [&_table]:text-[11.5px]",
        "[&_th]:border [&_th]:px-1.5 [&_th]:py-1 [&_th]:font-medium",
        "[&_td]:border [&_td]:px-1.5 [&_td]:py-1",
        "[&_td]:break-words [&_th]:break-words",
        // Horizontal rule
        "[&_hr]:my-3 [&_hr]:border-t",
        // Images — rare, and we don't proxy them so cors / privacy concerns
        // apply. Inline-cap so a runaway image can't blow up the rail width.
        "[&_img]:max-w-full [&_img]:h-auto [&_img]:rounded",
        // Math — keep KaTeX display blocks inside the rail and let inline math
        // wrap with surrounding text rather than forcing a horizontal scroll.
        "[&_.katex-display]:my-2 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden",
        "[&_.katex]:text-[1em]",
        // Root-level wrapping safety net — `min-w-0` lets the flex parent
        // shrink us below content width (otherwise children with intrinsic
        // width like long URLs can blow the card open), and the wrap rules
        // catch anything that slipped past the per-tag selectors above.
        "min-w-0 break-words [overflow-wrap:anywhere]",
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
          ]}
          rehypePlugins={[rehypeKatex]}
          components={markdownComponents}
        >
          {children}
        </ReactMarkdown>
      </Tooltip.Provider>
    </div>
  );
}
