import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Favicon } from "~/components/favicon";
import { domainOf } from "~/lib/favicon";
import { cn } from "~/lib/utils";

interface CitationLinkProps {
  href: string;
  children: ReactNode;
}

/**
 * Source pill for a link titled `cite` (`[label](url "cite")`): favicon and label, domain in a tooltip.
 * Self-contained under any host: it brings its own tooltip provider, and the `!` ink and
 * decoration utilities beat every host `[&_a]` link rule, so the pill look lives only here.
 * (`not-prose` marks the anchor as self-styled. Host wrap and offset rules have no visible
 * effect: the label truncates, and with no underline there is nothing to offset.)
 */
export function CitationLink({ href, children }: CitationLinkProps) {
  const domain = domainOf(href);

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              "not-prose mx-0.5 inline-flex max-w-[28ch] items-center gap-1 align-middle",
              "rounded-md border border-app-bg-3/50 bg-app-bg-a1 px-1.5 py-px",
              "text-[0.92em] !no-underline",
              "!text-app-fg-3 hover:bg-app-bg-a2 hover:!text-app-fg-4",
              "transition-[background-color,color,scale] duration-150 active:scale-[0.96]",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-3",
            )}
          >
            <Favicon domain={domain} size={14} className="rounded-[3px]" />
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
    </Tooltip.Provider>
  );
}
