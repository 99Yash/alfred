import { getStringPath } from "@alfred/contracts";
import * as Accordion from "@radix-ui/react-accordion";
import { Check, ChevronRight, ExternalLink, Scissors, X } from "lucide-react";
import { useId } from "react";
import { CodeBlock } from "~/components/markdown-renderer";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { animatedToolIcon, RunningToolIcon } from "./animated-tool-icons";
import {
  presentBrowsing,
  presentEvidence,
  type EntityView,
  type EvidenceBadge,
  type FetchUrlView,
  type RecordListView,
  type WebSearchView,
} from "./evidence";
import { Favicon } from "./favicon";
import { presentTool, type ToolCallView } from "./tool-call-presentation";

/** The single accordion item value — one card holds one expandable panel. */
const PANEL_ITEM = "panel";

/** Rows past this index share the last stagger delay, so a long record list
 * doesn't trail in for a full second. */
const MAX_STAGGERED_ROWS = 6;

/**
 * A successful tool result is JSON in almost every case, but the tool returns it
 * minified — one long wrapped line that reads as a wall of text. Re-indent it so
 * the expanded card is scannable. Returns null for anything that isn't a JSON
 * object/array (plain-text results, a bare scalar, or a truncated/sanitized
 * preview that no longer parses), so the caller falls back to the raw text.
 */
function prettyJson(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

/** Pull a clean reason out of a failed tool's result preview. */
function failureReason(resultPreview: string | undefined): string | undefined {
  const parsed = parseJsonRecord(resultPreview);
  if (!parsed) return resultPreview;
  const message = getStringPath(parsed, "error", "message");
  if (message) return message;
  return asString(parsed.message) ?? asString(parsed.error) ?? resultPreview;
}

/**
 * A single tool call surfaced inline as a light row — a sibling of the
 * reasoning "Thought" row, not a heavy card. While running, the label sweeps
 * the same shimmer mask as the reasoning trigger; it settles to a quiet check
 * (or red ×) once it lands. Routine tool calls stay visually subordinate to
 * the reply text; the framed treatment is reserved for the approval tray,
 * which actually demands a decision. The leading glyph is the integration's
 * own logo whenever the tool belongs to one, so the user can see at a glance
 * which service Alfred is touching.
 */
export function ToolCallCard({
  tools,
  inTrail = false,
}: {
  tools: ToolCallView[];
  /**
   * Rendered inside the auto-animated activity trail. The trail container owns
   * the enter/move animation (`useAutoAnimate`), so the card drops its own
   * `animate-chat-in` to avoid the two fighting over opacity/transform. A
   * standalone card (a lone tool with no trail) keeps its enter animation.
   */
  inTrail?: boolean;
}) {
  const panelId = useId();
  // A run of identical calls collapsed into one row (see buildTrail); they
  // share a tool name and status, so the first stands in for the label/glyph
  // and the rest only add to the count and the stacked results below.
  const tool = tools[0]!;
  const count = tools.length;
  const running = tool.status === "started";
  const failed = tool.status === "failed";
  // ADR-0070: the result had non-text bytes stripped before storage, so the
  // preview may be incomplete — flag it instead of letting it look pristine.
  const trimmed = !running && !failed && tools.some((t) => Boolean(t.sanitized));
  const expandable = !running && tools.some((t) => Boolean(t.resultPreview));

  const {
    brand,
    fallbackIcon: FallbackIcon,
    running: runningLabel,
    done,
    failed: failedLabel,
    detail,
  } = presentTool(tool);
  const title = running ? runningLabel : failed ? (failedLabel ?? `${done} failed`) : done;
  // Brandless system tools (web_search, spawn_sub_agent, …) get an animated
  // glyph in place of the flat wrench; brand-scoped tools keep their logo coin.
  const animatedIcon = brand ? undefined : animatedToolIcon(tool.toolName);
  // Browsing tools (fetch_url / web_search) get web-native treatment: the coin
  // becomes the site's own favicon, and the subline names the page/query so the
  // user sees *what* Alfred is reading at a glance. A folded run of different
  // URLs (count > 1) can't be one favicon, so it keeps the Chrome glyph.
  const browsing = presentBrowsing(tool);
  const faviconDomain = browsing?.kind === "fetch_url" && count === 1 ? browsing.domain : undefined;
  // Inline: for a browsing tool, the site/query; otherwise the human "what"
  // (brief / integration). The "why" of a failure goes in the expandable,
  // cleaned up from the raw result JSON.
  const secondary =
    browsing?.kind === "fetch_url"
      ? count === 1
        ? browsing.domain
        : detail
      : browsing?.kind === "web_search"
        ? browsing.query
        : detail;

  return (
    // Radix accordion so the panel animates its height both opening AND closing
    // (chat-accordion-down/up) — matching the sibling activity trail — instead
    // of popping in on mount and vanishing on collapse. `collapsible` lets the
    // one item toggle shut; a non-expandable card renders a disabled trigger.
    <Accordion.Root
      type="single"
      collapsible
      className={cn("text-[13px]", !inTrail && "animate-chat-in")}
    >
      <Accordion.Item value={PANEL_ITEM}>
        <Accordion.Header>
          <Accordion.Trigger
            disabled={!expandable}
            aria-controls={expandable ? panelId : undefined}
            className={cn(
              "group/toolrow -mx-2 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-app-fg-2",
              expandable ? "cursor-pointer" : "cursor-default",
            )}
          >
            {brand ? (
              // The integration's own app-icon coin. While in flight an indigo→
              // violet halo drifts behind it (chat-node-glow inherits the tile's
              // radius) so the eye lands on what's happening now.
              <span
                aria-hidden
                className={cn("inline-flex shrink-0 rounded-full", running && "chat-node-glow")}
              >
                <IntegrationIcon brand={brand} size="xs" />
              </span>
            ) : faviconDomain ? (
              // A browsing tool reading one page: show that site's own favicon on a
              // neutral coin, so the card reads as "Alfred is on cloudflare.com".
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 shadow-(--app-shadow-elevated)",
                  running && "chat-node-glow",
                )}
              >
                <Favicon domain={faviconDomain} size={16} />
              </span>
            ) : (
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)",
                  running && "chat-node-glow",
                )}
              >
                {animatedIcon ? (
                  <RunningToolIcon icon={animatedIcon.Icon} running={running} size={13} />
                ) : (
                  <FallbackIcon size={13} />
                )}
              </span>
            )}
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                running
                  ? "animate-chat-shimmer-mask text-app-fg-4"
                  : failed
                    ? "text-app-red-4"
                    : "text-app-fg-4",
              )}
            >
              {title}
            </span>
            {count > 1 ? (
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium tabular-nums",
                  failed ? "bg-app-red-2 text-app-red-4" : "bg-app-bg-2 text-app-fg-2",
                )}
                aria-label={`${count} times`}
              >
                {count}×
              </span>
            ) : null}
            {secondary ? (
              <span className="hidden max-w-[45%] min-w-0 truncate text-xs text-app-fg-3 sm:inline">
                {secondary}
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {trimmed ? (
                <span
                  className="inline-flex items-center text-app-fg-2"
                  title="Non-text bytes were stripped from this result before storage; it may be incomplete."
                >
                  <Scissors size={12} aria-label="Result trimmed before storage" />
                </span>
              ) : null}
              {running ? null : failed ? (
                <X size={14} aria-hidden className="text-app-red-4" />
              ) : (
                <Check size={14} aria-hidden className="text-app-green-4" />
              )}
              {expandable ? (
                <ChevronRight
                  size={14}
                  aria-hidden
                  className="text-app-fg-2 transition-[transform,color] duration-200 group-hover/toolrow:text-app-fg-4 group-data-[state=open]/toolrow:rotate-90"
                />
              ) : null}
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        {expandable ? (
          <Accordion.Content
            id={panelId}
            className="data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down overflow-hidden"
          >
            <div className="mt-1.5 ml-8">
              {trimmed ? (
                <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-app-fg-2">
                  <Scissors size={12} aria-hidden />
                  Non-text bytes were stripped before storage; this result may be incomplete.
                </p>
              ) : null}
              {/* One block per collapsed call — a single call renders exactly as
              before; a folded run stacks each call's result in arrival order.
              A successful JSON result renders pretty-printed in the shared dark
              CodeBlock card (label + copy + highlighting); a failure reason or a
              non-JSON preview stays a quiet muted line. */}
              {tools.map((t, i) => {
                if (failed) {
                  const reason = failureReason(t.resultPreview) ?? t.resultPreview;
                  if (!reason) return null;
                  return (
                    <pre
                      key={t.toolCallId}
                      className={cn(
                        "overflow-x-auto border-l-2 border-app-fg-a1 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-app-red-4/90",
                        i > 0 && "mt-1.5",
                      )}
                    >
                      {reason}
                    </pre>
                  );
                }
                // Browsing tools get a web-native panel — a linked page card or a
                // favicon result list — instead of a raw JSON dump. A web search
                // with no parsed citations falls through to the JSON (which still
                // carries the synthesized answer).
                const b = presentBrowsing(t);
                if (b?.kind === "fetch_url") {
                  return <FetchUrlDetail key={t.toolCallId} view={b} spaced={i > 0} />;
                }
                if (b?.kind === "web_search" && b.sources.length > 0) {
                  return <WebSearchDetail key={t.toolCallId} view={b} spaced={i > 0} />;
                }
                // Integration read tools (github.search, calendar, a PR, an email…)
                // get the same web-native evidence panel instead of a JSON dump.
                // A tool with no spec — or a preview too pruned to map — returns
                // null and falls through to the JSON/raw tiers below, unchanged.
                const evidence = presentEvidence(t);
                if (evidence?.kind === "record-list") {
                  return <EvidenceListDetail key={t.toolCallId} view={evidence} spaced={i > 0} />;
                }
                if (evidence?.kind === "entity") {
                  return <EntityDetail key={t.toolCallId} view={evidence} spaced={i > 0} />;
                }
                const raw = t.resultPreview;
                if (!raw) return null;
                const json = prettyJson(raw);
                if (json !== null) {
                  return (
                    <div key={t.toolCallId} className={cn(i > 0 && "mt-1.5")}>
                      <CodeBlock language="json" code={json} />
                    </div>
                  );
                }
                return (
                  <pre
                    key={t.toolCallId}
                    className={cn(
                      "overflow-x-auto border-l-2 border-app-fg-a1 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-app-fg-3",
                      i > 0 && "mt-1.5",
                    )}
                  >
                    {raw}
                  </pre>
                );
              })}
            </div>
          </Accordion.Content>
        ) : null}
      </Accordion.Item>
    </Accordion.Root>
  );
}

/**
 * The expanded panel for a `fetch_url` call: the page rendered as a linked card
 * (favicon + title + host), with a short peek at the text Alfred actually read
 * below it — the web-native counterpart to the raw JSON dump.
 */
function FetchUrlDetail({ view, spaced }: { view: FetchUrlView; spaced: boolean }) {
  return (
    <div className={cn("rounded-lg bg-app-bg-a1 p-2.5", spaced && "mt-1.5")}>
      <a
        href={view.href}
        target="_blank"
        rel="noreferrer noopener"
        className="group/link flex items-center gap-2 no-underline"
      >
        <Favicon domain={view.domain} size={16} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-app-fg-4 group-hover/link:underline">
          {view.title ?? view.domain}
        </span>
        <span className="hidden shrink-0 text-[11px] text-app-fg-3 sm:inline">{view.domain}</span>
        <ExternalLink size={12} aria-hidden className="shrink-0 text-app-fg-2" />
      </a>
      {view.excerpt ? (
        <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-app-fg-3">
          {view.excerpt}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The expanded panel for a `web_search` call: the source results as favicon +
 * title + host rows, each opening in a new tab — the same shape a person scans
 * on a results page, instead of a wall of citation JSON.
 */
function WebSearchDetail({ view, spaced }: { view: WebSearchView; spaced: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-app-bg-a2 overflow-hidden rounded-lg bg-app-bg-a1",
        spaced && "mt-1.5",
      )}
    >
      {view.sources.map((source) => (
        <a
          key={source.faviconDomain}
          href={source.href}
          target="_blank"
          rel="noreferrer noopener"
          className="group/result flex items-center gap-2 px-2.5 py-1.5 no-underline"
        >
          <Favicon domain={source.faviconDomain} size={16} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-app-fg-4 group-hover/result:underline">
            {source.label}
          </span>
          <span className="hidden shrink-0 text-[11px] text-app-fg-3 sm:inline">
            {source.faviconDomain}
          </span>
        </a>
      ))}
    </div>
  );
}

const BADGE_TONES: Record<EvidenceBadge["tone"], string> = {
  neutral: "bg-app-bg-2 text-app-fg-3",
  green: "bg-app-green-2 text-app-green-4",
  red: "bg-app-red-2 text-app-red-4",
  amber: "bg-app-amber-2 text-app-amber-4",
  purple: "bg-app-purple-2 text-app-purple-4",
};

/** A small colored status pill (PR state, deployment status). */
function BadgePill({ badge }: { badge: EvidenceBadge }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium capitalize",
        BADGE_TONES[badge.tone],
      )}
    >
      {badge.label}
    </span>
  );
}

/**
 * The expanded panel for a read tool that returned a list of records
 * (github.search, calendar.list_events, notion.search, …): each record as a
 * favicon + title + meta row — the same scannable shape as a web-search result
 * list — instead of a raw JSON dump. Rows link out when the record carries a
 * url; a link-less row still renders. A trailing "+N more" reflects the records
 * the server pruned from the preview, so the panel reads as an honest peek.
 */
function EvidenceListDetail({ view, spaced }: { view: RecordListView; spaced: boolean }) {
  const moreLabel =
    view.remaining && view.remaining > 0
      ? `+${view.remaining} more`
      : view.hasMore
        ? "More available"
        : null;
  return (
    <div className={cn("overflow-hidden rounded-lg", spaced && "mt-1.5")}>
      {view.query ? (
        <p className="truncate border-b border-app-bg-a2 bg-app-bg-a1 px-2.5 py-1.5 text-[11px] text-app-fg-3">
          {view.query}
        </p>
      ) : null}
      <div className="flex flex-col divide-y divide-app-bg-a2 bg-app-bg-a1">
        {view.rows.map((row, i) => {
          // Cascade the rows in as the panel opens: each fades up ~40ms after
          // the last (capped) so a list reads as arriving, not blinking on all
          // at once. `backwards` fill (see .animate-chat-row-in) holds each row
          // hidden through its delay. Disabled under prefers-reduced-motion.
          const stagger = { animationDelay: `${Math.min(i, MAX_STAGGERED_ROWS) * 40}ms` };
          const inner = (
            <>
              <Favicon domain={view.faviconDomain} size={16} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-app-fg-4 group-hover/row:underline">
                {row.title}
              </span>
              {row.meta ? (
                <span className="hidden shrink-0 truncate text-[11px] text-app-fg-3 sm:inline">
                  {row.meta}
                </span>
              ) : null}
              {row.badge ? <BadgePill badge={row.badge} /> : null}
            </>
          );
          return row.href ? (
            <a
              key={row.key}
              href={row.href}
              target="_blank"
              rel="noreferrer noopener"
              style={stagger}
              className="group/row animate-chat-row-in flex items-center gap-2 px-2.5 py-1.5 no-underline"
            >
              {inner}
            </a>
          ) : (
            <div
              key={row.key}
              style={stagger}
              className="group/row animate-chat-row-in flex items-center gap-2 px-2.5 py-1.5"
            >
              {inner}
            </div>
          );
        })}
      </div>
      {moreLabel ? (
        <p className="border-t border-app-bg-a2 bg-app-bg-a1 px-2.5 py-1.5 text-[11px] text-app-fg-2">
          {moreLabel}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The expanded panel for a read tool that returned a single object (a PR, an
 * issue, an email): a linked title with its state pill, a compact fact row
 * (repo · author · diff · commits, or from · to · date), and an optional body
 * peek — the entity counterpart to the record list above.
 */
function EntityDetail({ view, spaced }: { view: EntityView; spaced: boolean }) {
  return (
    <div className={cn("rounded-lg bg-app-bg-a1 p-2.5", spaced && "mt-1.5")}>
      {view.href ? (
        <a
          href={view.href}
          target="_blank"
          rel="noreferrer noopener"
          className="group/link flex items-center gap-2 no-underline"
        >
          <Favicon domain={view.faviconDomain} size={16} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-app-fg-4 group-hover/link:underline">
            {view.title}
          </span>
          {view.badge ? <BadgePill badge={view.badge} /> : null}
          <ExternalLink size={12} aria-hidden className="shrink-0 text-app-fg-2" />
        </a>
      ) : (
        <div className="flex items-center gap-2">
          <Favicon domain={view.faviconDomain} size={16} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-app-fg-4">
            {view.title}
          </span>
          {view.badge ? <BadgePill badge={view.badge} /> : null}
        </div>
      )}
      {view.facts.length > 0 ? (
        <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {view.facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 items-center gap-1">
              <dt className="shrink-0 text-app-fg-2">{fact.label}</dt>
              <dd className="min-w-0 truncate text-app-fg-3">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.excerpt ? (
        <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-app-fg-3">
          {view.excerpt}
        </p>
      ) : null}
    </div>
  );
}
