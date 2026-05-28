import { useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  Brain,
  CornerDownLeft,
  MessageSquare,
  NotebookPen,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  SquarePen,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { PreviewRecentThread } from "./preview-fixtures";

/**
 * Cmd-K search palette.
 *
 * Modal overlay mounted by `AppShell`. Provides a single keyboard-driven
 * entry point that fuzzy-matches across:
 *   • Static commands (New chat, Settings, Integrations, …)
 *   • Recent chat threads — *prop-driven*, only the `/preview/*` shell
 *     passes a fixture set today; the real surface stays empty until the
 *     chat thread sync (Replicache) lands in m13.
 *
 * Keyboard:
 *   • cmd/ctrl-K (handled by parent) — open
 *   • esc — close
 *   • up/down arrows — move highlight (wraps)
 *   • enter — invoke highlighted item
 *
 * The component is only mounted while open — the parent renders it
 * conditionally — so internal state is fresh on each open without
 * needing to reset on a prop change.
 */

export interface SearchPaletteProps {
  onClose: () => void;
  /** Recent threads to surface in the "Recent chats" group. Empty/omitted → group hidden. */
  recentThreads?: ReadonlyArray<PreviewRecentThread>;
}

type CommandKind = "command" | "thread";

interface CommandItem {
  id: string;
  kind: CommandKind;
  label: string;
  hint?: string;
  icon: LucideIcon;
  /** When set, navigate to this path on invoke. */
  to?: string;
  /** When set, run this on invoke (e.g. open settings modal — not wired yet). */
  onRun?: () => void;
  /** Free-form keywords to match in addition to the label. */
  keywords?: string;
}

const COMMANDS: ReadonlyArray<CommandItem> = [
  {
    id: "new-chat",
    kind: "command",
    label: "New chat",
    hint: "Start a fresh thread",
    icon: SquarePen,
    to: "/chat",
    keywords: "compose ask alfred",
  },
  {
    id: "integrations",
    kind: "command",
    label: "Integrations",
    hint: "Connect or manage providers",
    icon: Plug,
    to: "/integrations",
    keywords: "gmail calendar slack github drive",
  },
  {
    id: "workflows",
    kind: "command",
    label: "Workflows",
    hint: "Scheduled and triggered runs",
    icon: Workflow,
    to: "/workflows",
    keywords: "automation cron triggers",
  },
  {
    id: "skills",
    kind: "command",
    label: "Skills",
    hint: "Tools Alfred can call",
    icon: Wrench,
    keywords: "tools capabilities",
  },
  {
    id: "library",
    kind: "command",
    label: "Library",
    hint: "Saved artifacts and outputs",
    icon: BookOpen,
    keywords: "files documents artifacts",
  },
  {
    id: "approvals",
    kind: "command",
    label: "Approvals",
    hint: "Pending decisions",
    icon: ShieldCheck,
    keywords: "review approve",
  },
  {
    id: "memory",
    kind: "command",
    label: "Memory",
    hint: "Long-term notes Alfred remembers",
    icon: Brain,
    keywords: "knowledge facts",
  },
  {
    id: "notes",
    kind: "command",
    label: "Notes",
    hint: "Your scratch notes",
    icon: NotebookPen,
    keywords: "scratchpad",
  },
  {
    id: "settings",
    kind: "command",
    label: "Settings",
    hint: "Account, preferences, billing",
    icon: Settings2,
    to: "/settings",
    keywords: "preferences account features",
  },
];

function matchScore(item: CommandItem, query: string): number {
  if (!query) return 1;
  const haystack = `${item.label} ${item.keywords ?? ""}`.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  if (haystack.startsWith(needle)) return 3;
  if (haystack.includes(` ${needle}`)) return 2;
  if (haystack.includes(needle)) return 1;
  return 0;
}

export function SearchPalette({ onClose, recentThreads }: SearchPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Focus the input on mount. The parent only renders this component
  // while the palette is open, so this fires exactly once per open.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Build the full item list — commands plus the (prop-driven) recent
  // threads — once per prop change.
  const allItems = useMemo<ReadonlyArray<CommandItem>>(() => {
    if (!recentThreads || recentThreads.length === 0) return COMMANDS;
    const threadItems: CommandItem[] = recentThreads.map((t) => ({
      id: `thread-${t.id}`,
      kind: "thread",
      label: t.title,
      hint: t.when,
      icon: MessageSquare,
      to: "/chat",
      keywords: `${t.title} ${t.when}`,
    }));
    return [...COMMANDS, ...threadItems];
  }, [recentThreads]);

  // Filter + score in one pass to avoid the .map().filter() chain.
  const results = useMemo(() => {
    const ranked: { item: CommandItem; score: number }[] = [];
    for (const item of allItems) {
      const score = matchScore(item, query);
      if (score > 0) ranked.push({ item, score });
    }
    if (query.trim()) ranked.sort((a, b) => b.score - a.score);
    return ranked.map((r) => r.item);
  }, [allItems, query]);

  // Group results into commands + threads in a single pass so the visual
  // order is built once and shared by rendering and keyboard nav.
  const grouped = useMemo(() => {
    const commands: CommandItem[] = [];
    const threads: CommandItem[] = [];
    for (const item of results) {
      if (item.kind === "command") commands.push(item);
      else threads.push(item);
    }
    return { commands, threads };
  }, [results]);

  // Flat array in render order. Arrow keys walk this so the highlight
  // matches the visual sequence (commands first, then threads).
  const visualOrder = useMemo(() => [...grouped.commands, ...grouped.threads], [grouped]);

  // Clamp the highlight during render — no useEffect needed.
  const activeIndex = visualOrder.length === 0 ? 0 : Math.min(highlight, visualOrder.length - 1);

  const invoke = (item: CommandItem) => {
    onClose();
    if (item.to) {
      navigate({ to: item.to });
    } else if (item.onRun) {
      item.onRun();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (visualOrder.length === 0) return;
      setHighlight((activeIndex + 1) % visualOrder.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (visualOrder.length === 0) return;
      setHighlight((activeIndex - 1 + visualOrder.length) % visualOrder.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = visualOrder[activeIndex];
      if (item) invoke(item);
    }
  };

  return (
    <dialog
      open
      aria-label="Search palette"
      className={cn(
        // Override UA defaults: dialog ships with its own border, padding,
        // max-width/height and centered positioning — we want a full-bleed
        // overlay so the backdrop button covers the viewport.
        "fixed inset-0 z-[60] m-0 max-w-none max-h-none w-full h-full",
        "bg-transparent text-inherit border-0 p-0",
        "flex items-start justify-center pt-[12vh] vs-fade-in",
      )}
    >
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 bg-vs-background/55 backdrop-blur-[2px]"
      />

      <div
        className={cn(
          "relative w-full max-w-[640px] mx-4",
          "rounded-2xl bg-vs-bg-1 ring-1 ring-vs-bg-3/80",
          "shadow-[0_30px_80px_rgba(0,0,0,0.32)]",
          "overflow-hidden",
        )}
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-vs-bg-3/60">
          <Search size={15} className="text-vs-fg-2 shrink-0" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search chats and actions…"
            className={cn(
              "flex-1 min-w-0 bg-transparent text-sm text-vs-fg-4 placeholder:text-vs-fg-2",
              "outline-none focus-visible:outline-none",
            )}
            aria-label="Search query"
          />
          <kbd
            className={cn(
              "shrink-0 inline-flex items-center justify-center h-[18px] px-1.5 rounded-md",
              "text-[10.5px] font-medium tabular-nums",
              "bg-vs-bg-a2 text-vs-fg-2 font-sans",
            )}
          >
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto pb-2">
          {visualOrder.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-vs-fg-2">No matches.</div>
          ) : (
            <>
              {grouped.commands.length ? (
                <Group label="Actions">
                  {grouped.commands.map((item, i) => (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      active={i === activeIndex}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => invoke(item)}
                    />
                  ))}
                </Group>
              ) : null}
              {grouped.threads.length ? (
                <Group label="Recent chats">
                  {grouped.threads.map((item, i) => {
                    const flatIndex = grouped.commands.length + i;
                    return (
                      <PaletteRow
                        key={item.id}
                        item={item}
                        active={flatIndex === activeIndex}
                        onMouseEnter={() => setHighlight(flatIndex)}
                        onClick={() => invoke(item)}
                      />
                    );
                  })}
                </Group>
              ) : null}
            </>
          )}
        </div>

        <div
          className={cn(
            "flex items-center justify-between gap-3 px-4 h-10",
            "border-t border-vs-bg-3/60 bg-vs-bg-1/60",
          )}
        >
          <div className="flex items-center gap-3 text-[11px] text-vs-fg-2">
            <span className="inline-flex items-center gap-1.5">
              <FootKbd>↑</FootKbd>
              <FootKbd>↓</FootKbd>
              <span>Move</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FootKbd>
                <CornerDownLeft size={9} />
              </FootKbd>
              <span>Select</span>
            </span>
          </div>
          <span className="text-[11px] text-vs-fg-2">
            {visualOrder.length} result{visualOrder.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </dialog>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pt-1">
      <div className="px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
        {label}
      </div>
      <div className="space-y-0.5 px-1.5">{children}</div>
    </div>
  );
}

function PaletteRow({
  item,
  active,
  onMouseEnter,
  onClick,
}: {
  item: CommandItem;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        "group w-full flex items-center gap-3 rounded-xl h-10 px-2.5",
        "transition-colors",
        "outline-none",
        active ? "bg-vs-bg-2 text-vs-fg-4" : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-7 shrink-0 inline-flex items-center justify-center rounded-lg",
          "bg-vs-bg-2 text-vs-fg-3",
          active && "bg-vs-purple-1 text-vs-purple-4",
        )}
      >
        <Icon size={13} />
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block text-sm font-medium text-vs-fg-4 truncate">{item.label}</span>
        {item.hint ? (
          <span className="block text-[11px] text-vs-fg-2 truncate">{item.hint}</span>
        ) : null}
      </span>
      {active ? <CornerDownLeft size={12} aria-hidden className="shrink-0 text-vs-fg-2" /> : null}
    </button>
  );
}

function FootKbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded",
        "text-[10px] leading-none font-medium tabular-nums",
        "bg-vs-bg-a2 text-vs-fg-3 font-sans",
      )}
    >
      {children}
    </kbd>
  );
}
