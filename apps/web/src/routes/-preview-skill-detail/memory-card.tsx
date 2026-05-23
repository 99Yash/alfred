import { Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { VsCard } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";

export function MemoryCard({ body }: { body: string }) {
  return (
    <VsCard className="px-5 py-4">
      <article
        className={cn(
          "text-sm leading-6 text-vs-fg-4",
          /* Tighter list styling — the visitors aesthetic favors low
           * vertical density. Each list item gets a tiny purple
           * sparkle accent via list-style: none + ::marker fallback,
           * which we draw inline via a custom renderer below. */
          "[&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:m-0 [&_ul]:p-0 [&_ul]:list-none",
          "[&_li]:flex [&_li]:items-start [&_li]:gap-2.5",
          "[&_strong]:text-vs-fg-4 [&_strong]:font-medium",
          "[&_em]:text-vs-fg-3 [&_em]:not-italic [&_em]:font-mono [&_em]:text-[12.5px] [&_em]:rounded [&_em]:bg-vs-bg-2 [&_em]:px-1 [&_em]:py-px",
          "[&_p]:m-0",
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            li: ({ children }) => (
              <li>
                <Sparkles
                  size={13}
                  aria-hidden
                  className="mt-[3px] shrink-0 text-vs-purple-4"
                />
                <span className="min-w-0 flex-1">{children}</span>
              </li>
            ),
          }}
        >
          {body}
        </ReactMarkdown>
      </article>
    </VsCard>
  );
}
