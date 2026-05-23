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

/**
 * Cmd-K search palette.
 *
 * Modal overlay rendered by the preview shell. Provides a single
 * keyboard-driven entry point that fuzzy-matches across:
 *   • Static commands (New chat, Settings, Integrations, …)
 *   • Recent chat threads
 *
 * Keyboard:
 *   • cmd/ctrl-K (handled by parent) — open
 *   • esc — close
 *   • up/down arrows — move highlight (wraps)
 *   • enter — invoke highlighted item
 *
 * Mock thread list lives here for now — the real one will come from
 * Replicache when chat thread sync ships.
 */

export interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
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
    to: "/preview/chat",
    keywords: "compose ask alfred",
  },
  {
    id: "integrations",
    kind: "command",
    label: "Integrations",
    hint: "Connect or manage providers",
    icon: Plug,
    to: "/preview/integrations",
    keywords: "gmail calendar slack github drive",
  },
  {
    id: "workflows",
    kind: "command",
    label: "Workflows",
    hint: "Scheduled and triggered runs",
    icon: Workflow,
    to: "/preview/workflows",
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
    to: "/preview/settings",
    keywords: "preferences account features",
  },
];

interface ThreadEntry {
  id: string;
  title: string;
  when: string;
}

const RECENT_THREADS: ReadonlyArray<ThreadEntry> = [
  { id: "morning-brief", title: "Morning briefing — Friday", when: "Today" },
  { id: "sycamore-recap", title: "Sycamore investor update", when: "Today" },
  { id: "calendar-block", title: "Block focus time tomorrow", when: "Today" },
  { id: "triage-rules", title: "Tune triage label rules", when: "Yesterday" },
  { id: "vesting-q", title: "Vesting cliff question", when: "Yesterday" },
  { id: "weekly-recap", title: "Weekly recap — week 21", when: "Earlier" },
  { id: "cold-start", title: "Cold-start research notes", when: "Earlier" },
];

const THREAD_ITEMS: ReadonlyArray<CommandItem> = RECENT_THREADS.map((t) => ({
  id: `thread-${t.id}`,
  kind: "thread" as const,
  label: t.title,
  hint: t.when,
  icon: MessageSquare,
  to: "/preview/chat",
  keywords: `${t.title} ${t.when}`,
}));

const ALL_ITEMS: ReadonlyArray<CommandItem> = [...COMMANDS, ...THREAD_ITEMS];

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

export function SearchPalette({ open, onClose }: SearchPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset query + focus the input each time the palette is opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      // Defer one frame so the input is in the DOM before focusing.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const ranked = ALL_ITEMS.map((item) => ({ item, score: matchScore(item, query) })).filter(
      (r) => r.score > 0,
    );
    if (query.trim()) {
      ranked.sort((a, b) => b.score - a.score);
    }
    return ranked.map((r) => r.item);
  }, [query]);

  // Clamp highlight to results.length whenever results shrink.
  useEffect(() => {
    if (highlight >= results.length) setHighlight(Math.max(0, results.length - 1));
  }, [results.length, highlight]);

  // Group results for rendering. Commands first, threads second.
  const grouped = useMemo(() => {
    const commands = results.filter((r) => r.kind === "command");
    const threads = results.filter((r) => r.kind === "thread");
    return { commands, threads };
  }, [results]);

  if (!open) return null;

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
      setHighlight((h) => (results.length === 0 ? 0 : (h + 1) % results.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (results.length === 0 ? 0 : (h - 1 + results.length) % results.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = results[highlight];
      if (item) invoke(item);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search palette"
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] vs-fade-in"
      onKeyDown={onKeyDown}
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
            onChange={(e) => setQuery(e.target.value)}
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

        <div
          ref={listRef}
          className="max-h-[52vh] overflow-y-auto vs-scrollbar [scrollbar-width:thin] pb-2"
        >
          {results.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-vs-fg-2">No matches.</div>
          ) : (
            <>
              {grouped.commands.length ? (
                <Group label="Actions">
                  {grouped.commands.map((item) => (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      active={results.indexOf(item) === highlight}
                      onMouseEnter={() => setHighlight(results.indexOf(item))}
                      onClick={() => invoke(item)}
                    />
                  ))}
                </Group>
              ) : null}
              {grouped.threads.length ? (
                <Group label="Recent chats">
                  {grouped.threads.map((item) => (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      active={results.indexOf(item) === highlight}
                      onMouseEnter={() => setHighlight(results.indexOf(item))}
                      onClick={() => invoke(item)}
                    />
                  ))}
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
          <span className="text-[11px] text-vs-fg-2">{results.length} result{results.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
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
        active
          ? "bg-vs-bg-2 text-vs-fg-4"
          : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
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
      {active ? (
        <CornerDownLeft
          size={12}
          aria-hidden
          className="shrink-0 text-vs-fg-2"
        />
      ) : null}
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
