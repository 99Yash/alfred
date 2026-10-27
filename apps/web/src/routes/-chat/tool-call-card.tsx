import { getStringPath, toNonEmptyString } from "@alfred/contracts";
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight, ExternalLink, Scissors, Search, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useId } from "react";
import type { ResolvedToolCall } from "~/lib/chat/resolved-tool-call";
import { IntegrationGlyph, IntegrationIcon } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { RunningToolIcon } from "./animated-tool-icons";
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
import { Favicon } from "~/components/favicon";
import { ToolResultJson } from "./tool-result-json";
import type { McpServerLookup } from "./mcp-server";
import { presentTool } from "./tool-call-presentation";
import { foldClass } from "./trail";
import { CHAT_POP, CHAT_SWAP } from "./motion";

const PANEL_ITEM = "panel";

/** Rows past this index share the last stagger delay. */
const MAX_STAGGERED_ROWS = 6;

/** Each call's shape, resolved once and shared by the header and the panel. */
interface ResolvedCall {
  browsing: BrowsingView | null;
  evidence: RecordListView | EntityView | null;
}

/** Records found, including ones pruned from the preview. `undefined` when no call returned a list. */
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

function failureReason({
  result,
  resultPreview,
}: Pick<ResolvedToolCall, "result" | "resultPreview">): string | undefined {
  if (!result) return resultPreview;
  const message = getStringPath(result, "error", "message");

  if (message) return message;

  return toNonEmptyString(result.message) ?? toNonEmptyString(result.error) ?? resultPreview;
}

/**
 * One tool call as a light inline row. It shimmers and glows only while its call runs in a live
 * turn. A settled row dims one step with no glyph; a failed row shows a red ×.
 * The glyph is the integration's logo when the tool has one.
 */
export function ToolCallCard({
  tools,
  live,
  mcpServers,
}: {
  tools: ResolvedToolCall[];
  /** The run that owns these calls has not ended. Motion needs this AND a `started` call. */
  live: boolean;
  /** The parent's lookup. It already covers these calls, so the card asks for nothing itself. */
  mcpServers: McpServerLookup;
}) {
  const panelId = useId();
  // A folded run of identical calls (see buildTrail). Running if any call is out, failed if any failed.
  const [tool] = tools;

  // Every caller passes at least one call: a trail item or a sub-agent step.
  if (!tool) return null;
  const count = tools.length;
  const running = tools.some((t) => t.status === "started");
  // A call still `started` after its run stopped keeps its label but stops moving.
  const emphasized = live && running;
  const failed = tools.some((t) => foldClass(t.status) === "failed");
  // ADR-0070: non-text bytes were stripped, so flag the preview as incomplete.
  const trimmed = !failed && tools.some((t) => Boolean(t.sanitized));

  const {
    brand,
    icon,
    fallbackIcon: FallbackIcon,
    running: runningLabel,
    done,
    failed: failedLabel,
    detail,
    faviconDomain: serverFavicon,
  } = presentTool(tool, mcpServers);

  const resolved: ResolvedCall[] = tools.map((t) => ({
    browsing: presentBrowsing(t),
    evidence: presentEvidence(t),
  }));

  // Not gated on `running`, or an open panel would shut when a sibling starts.
  const expandable = tools.some((t) => Boolean(t.resultPreview));

  const title = running ? runningLabel : failed ? (failedLabel ?? `${done} failed`) : done;
  const BrandlessIcon = brand ? undefined : icon;
  // One browsing page shows its favicon; a fold of several URLs keeps the browsing glyph.
  // A user-added MCP server shows its vendor's favicon.
  const browsing = resolved[0]?.browsing ?? null;

  const faviconDomain =
    browsing?.kind === "fetch_url" && count === 1 ? browsing.domain : serverFavicon;

  // The search query for a single call; a fold of different queries falls back to the label.
  const query = count === 1 ? searchQueryOf(tool) : undefined;

  const secondary =
    browsing?.kind === "fetch_url" && count === 1 ? browsing.domain : (query ?? detail);

  // Only once landed: a climbing count reads as progress.
  const found = running || failed ? undefined : recordCount(resolved);

  return (
    // Radix accordion so the panel animates both open and close.
    <Accordion.Root type="single" collapsible className="text-[13px]">
      <Accordion.Item value={PANEL_ITEM}>
        <Accordion.Header>
          <Accordion.Trigger
            disabled={!expandable}
            aria-controls={expandable ? panelId : undefined}
            className={cn(
              "group/toolrow -mx-2 flex w-full items-center gap-2 rounded-control px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-app-fg-2",
              expandable ? "cursor-pointer" : "cursor-default",
            )}
          >
            {brand ? (
              // The halo marks the call in flight.
              <span
                aria-hidden
                className={cn("inline-flex shrink-0 rounded-full", emphasized && "chat-node-glow")}
              >
                <IntegrationIcon brand={brand} size="xs" />
              </span>
            ) : faviconDomain ? (
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 shadow-(--app-shadow-elevated)",
                  emphasized && "chat-node-glow",
                )}
              >
                <Favicon domain={faviconDomain} size={16} />
              </span>
            ) : (
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 shadow-(--app-shadow-elevated)",
                  // Settled drawn glyphs dim one step; logos and favicons keep their color.
                  running ? "text-app-fg-3" : "text-app-fg-2",
                  emphasized && "chat-node-glow",
                )}
              >
                {BrandlessIcon ? (
                  <RunningToolIcon icon={BrandlessIcon} running={emphasized} size={13} />
                ) : (
                  <FallbackIcon size={13} />
                )}
              </span>
            )}
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                running
                  ? cn("text-app-fg-4", emphasized && "animate-chat-shimmer-mask")
                  : failed
                    ? "text-app-red-4"
                    : cn(
                        "text-app-fg-3",
                        // A row the user can open brightens back to full on hover or focus.
                        expandable &&
                          "transition-colors group-hover/toolrow:text-app-fg-4 group-focus-visible/toolrow:text-app-fg-4",
                      ),
              )}
            >
              {/* Keyed on the text, so a fold whose label holds still does not blink.
                  `initial={false}`: a row that mounts finished shows its final label at once. */}
              <AnimatePresence mode="wait" initial={false}>
                <m.span
                  key={title}
                  className="block truncate"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={CHAT_SWAP}
                >
                  {title}
                </m.span>
              </AnimatePresence>
            </span>
            {count > 1 ? (
              <span
                className={cn(
                  "shrink-0 rounded-control-xs px-1.5 py-0.5 text-[10px] leading-none font-medium tabular-nums",
                  failed ? "bg-app-red-2 text-app-red-4" : "bg-app-bg-2 text-app-fg-2",
                )}
                aria-label={`${count} times`}
              >
                {count}×
              </span>
            ) : null}
            {secondary ? (
              // A dot, not a gap: the subline continues the title.
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
              {/* Only a failure earns a glyph; a settled success says so by going quiet. */}
              <AnimatePresence initial={false}>
                {!running && failed ? (
                  <m.span
                    key="x"
                    className="inline-flex"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={CHAT_POP}
                  >
                    <X size={14} aria-hidden className="text-app-red-4" />
                  </m.span>
                ) : null}
              </AnimatePresence>
              {expandable ? (
                // Opacity, not `hidden`, so the row's right edge holds still on hover.
                // Touch has no hover, so a coarse pointer always sees it.
                <ChevronRight
                  size={14}
                  aria-hidden
                  className="text-app-fg-2 opacity-0 transition-[transform,color,opacity] duration-200 group-hover/toolrow:text-app-fg-4 group-hover/toolrow:opacity-100 group-focus-visible/toolrow:opacity-100 group-data-[state=open]/toolrow:rotate-90 group-data-[state=open]/toolrow:opacity-100 pointer-coarse:opacity-100"
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
              {/* One block per folded call: a browsing or evidence panel, else pretty JSON, else a failure line. */}
              {tools.map((t, i) => {
                if (failed) {
                  const reason = failureReason(t) ?? t.resultPreview;

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

                // A web search with no parsed citations falls through to the JSON answer.
                const b = resolved[i]?.browsing ?? null;

                if (b?.kind === "fetch_url") {
                  return <FetchUrlDetail key={t.toolCallId} view={b} spaced={i > 0} />;
                }

                if (b?.kind === "web_search" && b.sources.length > 0) {
                  return <WebSearchDetail key={t.toolCallId} view={b} spaced={i > 0} />;
                }

                // No spec, or a preview too pruned to map, falls through to JSON.
                const evidence = resolved[i]?.evidence ?? null;

                if (evidence?.kind === "record-list") {
                  return <EvidenceListDetail key={t.toolCallId} view={evidence} spaced={i > 0} />;
                }

                if (evidence?.kind === "entity") {
                  return <EntityDetail key={t.toolCallId} view={evidence} spaced={i > 0} />;
                }

                const raw = t.resultPreview;

                if (!raw) return null;
                // Re-indent a minified object result; anything else shows as plain text.
                const json = t.result ? JSON.stringify(t.result, null, 2) : null;

                // Last resort: the themed surface, not the dark CodeBlock meant for reply code.
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

/** `fetch_url` panel: a linked page card and a peek at the text Alfred read. */
function FetchUrlDetail({ view, spaced }: { view: FetchUrlView; spaced: boolean }) {
  return (
    <div className={cn("rounded-control bg-app-bg-a1 p-2.5", spaced && "mt-1.5")}>
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

/** `web_search` panel: source rows that open in a new tab. */
function WebSearchDetail({ view, spaced }: { view: WebSearchView; spaced: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-app-bg-a2 overflow-hidden rounded-control bg-app-bg-a1",
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

function BadgePill({ badge }: { badge: EvidenceBadge }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-control-xs px-1.5 py-0.5 text-[10px] leading-none font-medium capitalize",
        BADGE_TONES[badge.tone],
      )}
    >
      {badge.label}
    </span>
  );
}

/** List panel for a read tool. "+N more" counts records pruned from the preview. */
function EvidenceListDetail({ view, spaced }: { view: RecordListView; spaced: boolean }) {
  const moreLabel =
    view.remaining && view.remaining > 0
      ? `+${view.remaining} more`
      : view.hasMore
        ? "More available"
        : null;

  return (
    <div className={cn("overflow-hidden rounded-control", spaced && "mt-1.5")}>
      {view.query ? (
        <p className="flex items-center gap-1.5 border-b border-app-bg-a2 bg-app-bg-a1 px-2.5 py-1.5 text-[11px] text-app-fg-3">
          <Search size={11} aria-hidden className="shrink-0 text-app-fg-2" />
          <span className="min-w-0 truncate font-mono">{view.query}</span>
        </p>
      ) : null}
      <div className="flex flex-col divide-y divide-app-bg-a2 bg-app-bg-a1">
        {view.rows.map((row, i) => {
          // ~40ms cascade, capped. `backwards` fill hides each row through its delay.
          const stagger = { animationDelay: `${Math.min(i, MAX_STAGGERED_ROWS) * 40}ms` };

          // Row glyph beats the list's; a real logo beats a favicon; a drawn mark is last.
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
                  className="size-4 shrink-0 rounded-control-xs bg-app-bg-2 ring-1 ring-app-bg-a3 ring-inset"
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

/** Panel for a single object: linked title, state pill, facts, and a body peek. */
function EntityDetail({ view, spaced }: { view: EntityView; spaced: boolean }) {
  return (
    <div className={cn("rounded-control bg-app-bg-a1 p-2.5", spaced && "mt-1.5")}>
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
