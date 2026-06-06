import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

interface MarkdownRendererProps {
  children: string;
  className?: string;
}

/**
 * Renders email/note bodies as markdown.
 *
 *  - `remark-gfm` handles GitHub-flavored extensions (tables, strikethrough,
 *    autolinks, task lists). Most plain-text email signatures + GitHub /
 *    Linear notification mails arrive in this dialect already.
 *  - `remark-breaks` turns single `\n` into `<br>`. Gmail bodies extracted
 *    from `text/plain` rely on hard line breaks, not paragraph spacing —
 *    without this they'd collapse into prose blocks.
 *
 * The element overrides below keep links from leaking the user's referrer
 * and force every outbound click to a new tab. Anything else falls through
 * to react-markdown's defaults wrapped in our Tailwind typography.
 */
export function MarkdownRenderer({ children, className }: MarkdownRendererProps) {
  return (
    <div
      className={cn(
        "text-[12.5px] leading-[1.6] text-app-fg-3",
        // Block spacing — tighter than `prose` defaults, which read as
        // "article" rather than "email body" at this scale.
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-app-fg-4 [&_h1]:mt-3 [&_h1]:mb-1.5",
        "[&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-app-fg-4 [&_h2]:mt-3 [&_h2]:mb-1.5",
        "[&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-app-fg-4 [&_h3]:mt-2.5 [&_h3]:mb-1",
        "[&_h4]:text-[12.5px] [&_h4]:font-semibold [&_h4]:text-app-fg-4 [&_h4]:mt-2 [&_h4]:mb-1",
        // Inline text
        "[&_strong]:font-semibold [&_strong]:text-app-fg-4",
        "[&_em]:italic",
        "[&_a]:text-app-purple-4 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-app-purple-3",
        "[&_a]:break-words",
        // Lists
        "[&_ul]:my-2 [&_ul]:pl-4 [&_ul]:list-disc [&_ul]:marker:text-app-fg-2",
        "[&_ol]:my-2 [&_ol]:pl-4 [&_ol]:list-decimal [&_ol]:marker:text-app-fg-2",
        "[&_li]:my-0.5 [&_li]:pl-0.5",
        // Blockquote — typical "On X wrote:" reply chains land here once we
        // add the quote-detector. Until then this still tames the rare `>` line.
        "[&_blockquote]:border-l-2 [&_blockquote]:border-app-bg-3/60 [&_blockquote]:pl-3",
        "[&_blockquote]:my-2 [&_blockquote]:text-app-fg-2",
        // Code — inline tokens like `useInfiniteQuery` and quoted file refs
        // (`chat-shell.tsx:450`) routinely exceed the rail width.
        // `overflow-wrap: anywhere` lets the browser break mid-token *only
        // when* a word boundary won't fit on the line — keeping single
        // identifiers intact whenever they have room. Avoid `break-all`,
        // which slices every long-ish token across lines even when it
        // would fit by simply wrapping onto the next row.
        "[&_code]:rounded [&_code]:bg-app-bg-a2 [&_code]:px-1 [&_code]:py-px",
        "[&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-app-fg-4",
        "[&_code]:[overflow-wrap:anywhere]",
        // Fenced ``` blocks soft-wrap instead of horizontal-scrolling —
        // the rail is too narrow for a usable scroll affordance, and the
        // user wants the content readable at viewport width. `pre-wrap`
        // preserves the leading whitespace that diff blocks rely on for
        // alignment; `overflow-wrap: anywhere` catches over-long lines.
        "[&_pre]:my-2 [&_pre]:rounded-md [&_pre]:bg-app-bg-a2 [&_pre]:p-2",
        "[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:whitespace-pre-wrap",
        // Tables — emails rarely contain them, but newsletters sometimes do.
        // Wrap the table in a horizontal scroller (display:block on the table
        // itself) so wide tables stay tabular rather than collapsing column
        // structure. Body cells still wrap their text.
        "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto",
        "[&_table]:border-collapse [&_table]:text-[11.5px]",
        "[&_th]:border [&_th]:border-app-bg-3/40 [&_th]:px-1.5 [&_th]:py-1 [&_th]:font-medium [&_th]:text-app-fg-4",
        "[&_td]:border [&_td]:border-app-bg-3/40 [&_td]:px-1.5 [&_td]:py-1",
        "[&_td]:break-words [&_th]:break-words",
        // Horizontal rule
        "[&_hr]:my-3 [&_hr]:border-t [&_hr]:border-app-bg-3/60",
        // Images — rare, and we don't proxy them so cors / privacy concerns
        // apply. Inline-cap so a runaway image can't blow up the rail width.
        "[&_img]:max-w-full [&_img]:h-auto [&_img]:rounded",
        // Root-level wrapping safety net — `min-w-0` lets the flex parent
        // shrink us below content width (otherwise children with intrinsic
        // width like long URLs can blow the card open), and the wrap rules
        // catch anything that slipped past the per-tag selectors above.
        "min-w-0 break-words [overflow-wrap:anywhere]",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node: _node, children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
