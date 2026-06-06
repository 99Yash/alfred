import type { SyncedBriefing } from "@alfred/sync";
import { ChevronRight } from "lucide-react";
import { VsCard } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import { BriefingProse } from "./briefing-prose";
import { slotLabel } from "./briefing-utils";
import { formatEventRange, parseActivitySubtitle, ProviderGlyph, SourceIcon } from "./source-meta";

/** Statuses that never produced prose — render a calm placeholder, not a blank. */
const NON_TERMINAL = new Set(["pending", "gathering", "composing", "failed"]);

/**
 * One slot of a day (morning or evening), paragraph-first per ADR-0048/0049:
 * the composed `breaking_summary` leads and is always expanded; `sourcePanels`
 * are collapsible supporting detail; sections are secondary. A `suppressed`
 * morning renders identically to any row — its prose is just short — with at
 * most a subtle "Not emailed" line. No special quiet-day chrome.
 */
export function BriefingSlot({ briefing }: { briefing: SyncedBriefing }) {
  const { slot, status, breakingSummary, fullBriefing, gather, timezone } = briefing;
  const hasProse = Boolean(breakingSummary);
  const panels = fullBriefing?.sourcePanels ?? [];
  const sections = fullBriefing?.sections ?? [];
  const auditSummary = fullBriefing?.auditSummary;

  return (
    <VsCard className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-tight text-vs-fg-2">
          {slotLabel(slot)}
        </h2>
        {status === "suppressed" ? (
          <span className="text-[11px] text-vs-fg-2">Not emailed</span>
        ) : null}
      </div>

      {hasProse ? (
        <BriefingProse
          markdown={breakingSummary ?? ""}
          gather={gather}
          className="text-[15px] leading-7 text-pretty text-vs-fg-4"
        />
      ) : (
        <p className="text-sm text-vs-fg-3">
          {NON_TERMINAL.has(status)
            ? "This briefing hasn't finished composing yet."
            : "No briefing content for this slot."}
        </p>
      )}

      {sections.length > 0 ? (
        <Disclosure summary={`Detail (${sections.length})`}>
          <div className="space-y-4 pt-3">
            {sections.map((section, i) => (
              <div key={i} className="space-y-1">
                <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-tight text-vs-fg-2">
                  <SourceIcon source={section.source} />
                  {section.label}
                </p>
                <BriefingProse
                  markdown={section.body}
                  gather={gather}
                  className="text-sm leading-6 text-pretty text-vs-fg-3"
                />
                {section.why ? <p className="text-xs italic text-vs-fg-2">{section.why}</p> : null}
              </div>
            ))}
          </div>
        </Disclosure>
      ) : null}

      {panels.length > 0 ? (
        <Disclosure summary="Sources">
          <div className="space-y-4 pt-3">
            {panels.map((panel) => (
              <div key={panel.source} className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-tight text-vs-fg-2">
                  <SourceIcon source={panel.source} />
                  {panel.label}
                </p>
                <ul className="space-y-1">
                  {panel.items.map((item) => {
                    // Per-source subtitle polish: format calendar ISO ranges into
                    // human times, and split the activity provider into a brand
                    // glyph so the leading "github · github." noise is dropped.
                    const activity =
                      panel.source === "integration_activity" && item.subtitle
                        ? parseActivitySubtitle(item.subtitle)
                        : null;
                    const subtitle = activity
                      ? activity.detail
                      : panel.source === "calendar" && item.subtitle
                        ? formatEventRange(item.subtitle, timezone)
                        : item.subtitle;
                    const isTime = panel.source === "calendar";
                    return (
                      <li key={item.id} className="flex items-baseline gap-2 text-sm leading-5">
                        {activity ? (
                          <span className="shrink-0 translate-y-[2px]">
                            <ProviderGlyph provider={activity.provider} size={13} />
                          </span>
                        ) : null}
                        <span className="min-w-0">
                          {item.href ? (
                            <a
                              href={item.href}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-vs-fg-4 underline decoration-vs-bg-3 underline-offset-2 hover:decoration-current"
                            >
                              {item.title}
                            </a>
                          ) : (
                            <span className="text-vs-fg-4">{item.title}</span>
                          )}
                          {subtitle ? (
                            <span className={cn("text-vs-fg-2", isTime && "tabular-nums")}>
                              {" · "}
                              {subtitle}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </Disclosure>
      ) : null}

      {auditSummary ? (
        <Disclosure summary="How this was put together">
          <p className="pt-3 text-xs leading-5 text-vs-fg-3">{auditSummary}</p>
        </Disclosure>
      ) : null}
    </VsCard>
  );
}

/** Native collapsed-by-default disclosure with a rotating chevron. */
function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-vs-bg-2 pt-3">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-vs-fg-3",
          "transition-colors hover:text-vs-fg-4",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background rounded",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight size={13} aria-hidden className="transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      {children}
    </details>
  );
}
