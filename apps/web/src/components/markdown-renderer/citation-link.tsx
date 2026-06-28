import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { domainOf, faviconFor } from "~/lib/favicon";
import { cn } from "~/lib/utils";

interface CitationLinkProps {
  href: string;
  children: ReactNode;
}

/**
 * Inline source pill rendered for markdown links tagged with a `cite` title —
 * `[label](https://example.com "cite")`. Shows the source favicon + label, with
 * the domain in a tooltip. Alfred's adaptation of dimension's citation link:
 * favicon-by-domain (matching the existing web-search citation grammar) rather
 * than a fixed integration-icon catalog.
 */
export function CitationLink({ href, children }: CitationLinkProps) {
  const domain = domainOf(href);

  return (
    <Tooltip.Root delayDuration={200}>
      <Tooltip.Trigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            "not-prose mx-0.5 inline-flex max-w-[28ch] items-center gap-1 align-middle",
            "rounded-md border border-app-bg-3/50 bg-app-bg-a1 px-1.5 py-px",
            "text-[0.92em] no-underline",
            "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
            "transition-[background-color,color,scale] duration-150 active:scale-[0.96]",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-3",
          )}
        >
          <span className="grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-[3px] ring-1 ring-white/10 ring-inset">
            <img
              src={faviconFor(domain)}
              alt=""
              aria-hidden
              loading="lazy"
              className="size-full object-cover"
            />
          </span>
          <span className="truncate">{children}</span>
        </a>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          className={cn(
            "z-50 rounded-md px-2 py-1 text-[11px] font-medium",
            "bg-app-fg-4 text-app-bg-1 shadow-md",
            "select-none",
          )}
        >
          {domain}
          <Tooltip.Arrow className="fill-app-fg-4" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
