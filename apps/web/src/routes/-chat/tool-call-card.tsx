import { getStringPath } from "@alfred/contracts";
import * as Accordion from "@radix-ui/react-accordion";
import { Check, ChevronRight, ExternalLink, Scissors, Search, X } from "lucide-react";
import { useId } from "react";
import { IntegrationGlyph, IntegrationIcon } from "~/lib/integrations/integration-icons";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { brandlessToolIcon, RunningToolIcon } from "./animated-tool-icons";
import {
  presentBrowsing,
  presentEvidence,
  searchQueryOf,
  type BrowsingView,
  type EntityView,
  type EvidenceBadge,
  type FetchUrlView,
  type RecordListView,
  type WebSearchView,
} from "./evidence";
import { Favicon } from "./favicon";
import { ToolResultJson } from "./tool-result-json";
import { presentTool, type ToolCallView } from "./tool-call-presentation";
import { foldClass } from "./trail";

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

/**
 * What one call in the row resolved to, computed once per render. The header
 * needs the head call's shape (its subline, its record count) and the panel
 * needs every call's, so resolving them together keeps each preview parsed a
 * single time instead of once per reader.
 */
interface ResolvedCall {
  browsing: BrowsingView | null;
  evidence: RecordListView | EntityView | null;
}

/**
 * How many records the row's calls found, counting the ones the server pruned
 * from the preview. This is the number the user wants before deciding to open
 * the panel — "18 results" and "1 result" are different answers to the same
 * search. Returns `undefined` when no call returned a countable list, so a
 * fetch or a write never grows a meaningless "0".
 */
function recordCount(resolved: ResolvedCall[]): number | undefined {
  let total = 0;
  let counted = false;

  for (const { evidence } of resolved) {
    if (evidence?.kind !== "record-list") continue;
    counted = true;
    total += evidence.rows.length + (evidence.remaining ?? 0);
  }

  return counted ? total : undefined;
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
  inTrail?: boolean | undefined;
}) {
  const panelId = useId();
  // A run of identical calls collapsed into one row (see buildTrail); they
  // share a tool name and `foldClass`, so the first stands in for the label and
  // glyph and the rest only add to the count and the stacked results below.
  // Both verdicts are read across the whole run, not off its head: it reads as
  // running while any call is still out, and as failed if any call failed, so
  // a row that somehow mixes classes can never hide a failure.
  const tool = tools[0]!;
  const count = tools.length;
  const running = tools.some((t) => t.status === "started");
  const failed = tools.some((t) => foldClass(t.status) === "failed");
  // ADR-0070: the result had non-text bytes stripped before storage, so the
  // preview may be incomplete — flag it instead of letting it look pristine.
  const trimmed = !failed && tools.some((t) => Boolean(t.sanitized));

  const {
    brand,
    fallbackIcon: FallbackIcon,
    running: runningLabel,
    done,
    failed: failedLabel,
    detail,
    suppressResult,
  } = presentTool(tool);

  // Every call's display shape, resolved once and shared by the header and the
  // panel below it.
  const resolved: ResolvedCall[] = tools.map((t) => ({
    browsing: presentBrowsing(t),
    evidence: presentEvidence(t),
  }));

  // Expandable as soon as any call has a result. Not gated on `running`: a run
  // the user opened mid-turn would otherwise slam shut each time a sibling call
  // starts, and a still-streaming call simply contributes no block below. A
  // bookkeeping result (`load_tool`) offers no panel at all unless it failed,
  // because `{"ok":true,…}` is not evidence — see `suppressResult`.
  const expandable =
    tools.some((t) => Boolean(t.resultPreview)) && (failed || suppressResult !== true);

  const title = running ? runningLabel : failed ? (failedLabel ?? `${done} failed`) : done;
  // Brandless system tools (web_search, corpus_search, …) get their own glyph
  // in place of the flat wrench; brand-scoped tools keep their logo coin.
  const BrandlessIcon = brand ? undefined : brandlessToolIcon(tool.toolName);
  // Browsing tools (fetch_url / web_search) get web-native treatment: the coin
  // becomes the site's own favicon, and the subline names the page/query so the
  // user sees *what* Alfred is reading at a glance. A folded run of different
  // URLs (count > 1) can't be one favicon, so it keeps the browsing glyph.
  const browsing = resolved[0]?.browsing ?? null;
  const faviconDomain = browsing?.kind === "fetch_url" && count === 1 ? browsing.domain : undefined;

  // Inline: what Alfred actually looked for, when the call is a search and the
  // row stands for exactly one of them — a folded run of different queries has
  // no single answer, so it falls back to the human "what" (brief /
  // integration). A `fetch_url` row names its site instead, because the page is
  // the target there. The "why" of a failure goes in the expandable, cleaned up
  // from the raw result JSON.
  const query = count === 1 ? searchQueryOf(tool) : undefined;

  const secondary =
    browsing?.kind === "fetch_url" && count === 1 ? browsing.domain : (query ?? detail);

  // Shown only once the work lands: a count that climbs while the row streams
  // reads as a progress bar the panel cannot honor.
  const found = running || failed ? undefined : recordCount(resolved);

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
                {BrandlessIcon ? (
                  <RunningToolIcon icon={BrandlessIcon} running={running} size={13} />
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
              // A separator dot rather than a second column: the subline is a
              // continuation of the title ("Searched Gmail · from:stripe"), and
              // a bare gap reads as two unrelated labels.
              <span className="hidden max-w-[45%] min-w-0 items-center gap-1.5 text-xs text-app-fg-3 sm:flex">
                <span aria-hidden className="shrink-0 text-app-fg-1">
                  ·
                </span>
                <span className={cn("min-w-0 truncate", query && "font-mono text-[11px]")}>
                  {secondary}
                </span>
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {found === undefined ? null : (
                <span className="text-[11px] text-app-fg-2 tabular-nums">
                  {found} {found === 1 ? "result" : "results"}
                </span>
              )}
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
              A mapped result renders as an evidence panel; anything left over
              renders pretty-printed on the themed result surface; a failure
              reason stays a quiet muted line. */}
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
                const b = resolved[i]?.browsing ?? null;

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
                const evidence = resolved[i]?.evidence ?? null;

                if (evidence?.kind === "record-list") {
                  return <EvidenceListDetail key={t.toolCallId} view={evidence} spaced={i > 0} />;
                }

                if (evidence?.kind === "entity") {
                  return <EntityDetail key={t.toolCallId} view={evidence} spaced={i > 0} />;
                }

                const raw = t.resultPreview;

                if (!raw) return null;
                const json = prettyJson(raw);

                // Last resort, for a result no spec maps. Both tiers render on
                // the same themed surface (see ToolResultJson) — the markdown
                // CodeBlock this replaced is a fixed dark slab, which belongs
                // around quoted code in a reply, not around a trail row.
                return (
                  <div key={t.toolCallId} className={cn(i > 0 && "mt-1.5")}>
                    <ToolResultJson json={json ?? raw} plain={json === null} />
                  </div>
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

const BADGE_TONES = {
  neutral: "bg-app-bg-2 text-app-fg-3",
  green: "bg-app-green-2 text-app-green-4",
  red: "bg-app-red-2 text-app-red-4",
  amber: "bg-app-amber-2 text-app-amber-4",
  purple: "bg-app-purple-2 text-app-purple-4",
} satisfies Record<EvidenceBadge["tone"], string>;

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
        <p className="flex items-center gap-1.5 border-b border-app-bg-a2 bg-app-bg-a1 px-2.5 py-1.5 text-[11px] text-app-fg-3">
          <Search size={11} aria-hidden className="shrink-0 text-app-fg-2" />
          <span className="min-w-0 truncate font-mono">{view.query}</span>
        </p>
      ) : null}
      <div className="flex flex-col divide-y divide-app-bg-a2 bg-app-bg-a1">
        {view.rows.map((row, i) => {
          // Cascade the rows in as the panel opens: each fades up ~40ms after
          // the last (capped) so a list reads as arriving, not blinking on all
          // at once. `backwards` fill (see .animate-chat-row-in) holds each row
          // hidden through its delay. Disabled under prefers-reduced-motion.
          const stagger = { animationDelay: `${Math.min(i, MAX_STAGGERED_ROWS) * 40}ms` };

          // A row's own glyph wins over the list's: a corpus search answers
          // across several services at once, so "which service is this hit
          // from" is a per-row fact there. `IntegrationGlyph` draws the real
          // logo, which is why it is preferred over a fetched favicon, and a
          // drawn mark is the last resort for a record no service owns.
          const domain = row.faviconDomain ?? view.faviconDomain;
          const RowIcon = row.icon;

          const inner = (
            <>
              {row.brand ? (
                <span className="grid size-4 shrink-0 place-items-center">
                  <IntegrationGlyph brand={row.brand} size={14} />
                </span>
              ) : domain ? (
                <Favicon domain={domain} size={16} />
              ) : RowIcon ? (
                <span className="grid size-4 shrink-0 place-items-center text-app-fg-3">
                  <RowIcon size={14} />
                </span>
              ) : (
                <span
                  aria-hidden
                  className="size-4 shrink-0 rounded-[4px] bg-app-bg-2 ring-1 ring-white/10 ring-inset"
                />
              )}
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
