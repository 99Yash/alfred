import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUp,
  CalendarDays,
  ChevronDown,
  FileText,
  FolderOpen,
  Github,
  Globe2,
  Mail,
  Mic,
  Paperclip,
  Plug,
  Plus,
  Presentation,
  Rows3,
  Slack,
  Sparkles,
  Table2,
  Users,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { authClient } from "~/lib/auth-client";
import { useRightRail } from "~/lib/app-shell";
import { client } from "~/lib/eden";
import { ToolButton } from "~/lib/ui";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: () => client.health.get(),
    staleTime: 30_000,
  });

  const name = displayName(session?.user);
  const now = useNow();
  const greeting = useMemo(() => greetingFor(now), [now]);
  const longDate = useMemo(() => formatLongDate(now), [now]);

  const healthOk = Boolean(health?.data && "ok" in health.data && health.data.ok);

  // Right-rail widget — date / status / quick suggestions placeholder. Memoize
  // the node so its identity is stable while deps haven't changed — otherwise
  // we'd loop the AppShell state on every render.
  const rightRail = useMemo(
    () =>
      session?.user ? (
        <HomeRightRail longDate={longDate} healthOk={healthOk} healthLoading={healthLoading} />
      ) : null,
    [session?.user, longDate, healthOk, healthLoading],
  );
  useRightRail(rightRail);

  // Logged out — show a quiet landing without the full shell chrome.
  if (!sessionPending && !session?.user) {
    return (
      <div className="min-h-[100dvh] grid place-items-center px-6">
        <div className="text-center space-y-4">
          <h1 className="font-serif text-5xl tracking-tight">Alfred</h1>
          <p className="text-sm text-muted-foreground">
            Server: {healthLoading ? "checking…" : healthOk ? "online" : "not reachable"}
          </p>
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm hover:bg-accent/60 transition-colors"
          >
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col">
      {/* Top spacer to keep the mobile hamburger from colliding with the title */}
      <div className="md:hidden h-14 shrink-0" />

      <div className="flex-1 grid place-items-center px-4 sm:px-6 lg:px-10">
        <div className="w-full max-w-2xl space-y-8 -mt-16 md:-mt-8">
          <header className="text-center space-y-2">
            <p className="text-[12px] tracking-wide text-muted-foreground tabular">{longDate}</p>
            <h1 className="font-serif text-3xl sm:text-4xl md:text-5xl tracking-tight leading-tight">
              {greeting}, <span className="italic text-muted-foreground/90">{name}</span>
            </h1>
          </header>

          <Composer />

          <div className="flex flex-wrap items-center justify-center gap-2">
            <ChipLink href="/skills" icon={<Sparkles size={13} />}>
              Teach Alfred a skill
            </ChipLink>
            <ChipLink href="/memory" icon={<Wand2 size={13} />}>
              Review memory
            </ChipLink>
            <ChipLink href="/notes" icon={<Paperclip size={13} />}>
              Capture a note
            </ChipLink>
          </div>

          <p className="text-center text-[11px] text-muted-foreground/80">
            <Plug size={11} className="inline -mt-0.5 mr-1" />
            <span>Chat surface lands with m13.</span>{" "}
            <span className="opacity-70">
              The composer above is a preview — input is logged, not sent.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type MentionItem = {
  id: string;
  label: string;
  aliases: string[];
  icon: ComponentType<{ size?: number; className?: string }>;
  connected?: boolean;
};

const MENTION_ITEMS: MentionItem[] = [
  {
    id: "collaborators",
    label: "Collaborators",
    aliases: ["people", "teammates", "users"],
    icon: Users,
  },
  {
    id: "github",
    label: "GitHub",
    aliases: ["gh", "repo", "repos", "pull request", "issue"],
    icon: Github,
    connected: true,
  },
  {
    id: "gmail",
    label: "Gmail",
    aliases: ["mail", "email", "inbox"],
    icon: Mail,
    connected: true,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    aliases: ["calendar", "meetings", "events"],
    icon: CalendarDays,
    connected: true,
  },
  {
    id: "google_drive",
    label: "Google Drive",
    aliases: ["drive", "files"],
    icon: FolderOpen,
    connected: true,
  },
  {
    id: "google_docs",
    label: "Google Docs",
    aliases: ["docs", "documents"],
    icon: FileText,
  },
  {
    id: "google_sheets",
    label: "Google Sheets",
    aliases: ["sheets", "spreadsheet", "spreadsheets"],
    icon: Table2,
  },
  {
    id: "google_slides",
    label: "Google Slides",
    aliases: ["slides", "presentation", "deck"],
    icon: Presentation,
  },
  {
    id: "linear",
    label: "Linear",
    aliases: ["issues", "tickets", "projects"],
    icon: Rows3,
  },
  {
    id: "slack",
    label: "Slack",
    aliases: ["messages", "channels", "chat"],
    icon: Slack,
  },
  {
    id: "web",
    label: "Web",
    aliases: ["browser", "search", "internet"],
    icon: Globe2,
  },
];

function Composer() {
  const [value, setValue] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const hasContent = value.trim().length > 0;
  const filteredMentions = useMemo(() => filterMentions(mentionQuery), [mentionQuery]);

  const send = () => {
    if (!hasContent) return;
    // Stubbed until m13 lands the chat surface.
    // eslint-disable-next-line no-console
    console.info("[alfred] composer submit:", value.trim());
    setValue("");
    setMentionOpen(false);
    setMentionStart(null);
    setMentionQuery("");
    queueMicrotask(() => ref.current?.focus());
  };

  const syncMentionState = useCallback((nextValue: string, caret: number) => {
    const token = activeMentionToken(nextValue, caret);
    if (!token) {
      setMentionOpen(false);
      setMentionStart(null);
      setMentionQuery("");
      return;
    }

    setMentionStart(token.start);
    setMentionQuery(token.query);
    setMentionOpen(true);
  }, []);

  const insertMention = useCallback(
    (item: MentionItem) => {
      const textarea = ref.current;
      const caret = textarea?.selectionStart ?? value.length;
      const start = mentionStart ?? activeMentionToken(value, caret)?.start;
      if (start == null) return;

      const next = `${value.slice(0, start)}@${item.label} ${value.slice(caret)}`;
      const nextCaret = start + item.label.length + 2;
      setValue(next);
      setMentionOpen(false);
      setMentionStart(null);
      setMentionQuery("");

      requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [mentionStart, value],
  );

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mentionQuery]);

  useEffect(() => {
    if (selectedMentionIndex >= filteredMentions.length) {
      setSelectedMentionIndex(0);
    }
  }, [filteredMentions.length, selectedMentionIndex]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className={cn(
        "relative rounded-2xl border bg-card shadow-soft",
        "focus-within:ring-2 focus-within:ring-ring/40 focus-within:border-foreground/40",
        "transition-shadow",
      )}
    >
      {mentionOpen ? (
        <MentionMenu
          items={filteredMentions}
          selectedIndex={selectedMentionIndex}
          query={mentionQuery}
          onSelect={insertMention}
          onHover={setSelectedMentionIndex}
        />
      ) : null}

      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          const nextValue = e.target.value;
          setValue(nextValue);
          syncMentionState(nextValue, e.target.selectionStart);
        }}
        onClick={(e) => {
          syncMentionState(value, e.currentTarget.selectionStart);
        }}
        onKeyUp={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            syncMentionState(value, e.currentTarget.selectionStart);
          }
        }}
        onKeyDown={(e) => {
          if (mentionOpen) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedMentionIndex((i) =>
                filteredMentions.length === 0 ? 0 : (i + 1) % filteredMentions.length,
              );
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedMentionIndex((i) =>
                filteredMentions.length === 0
                  ? 0
                  : (i - 1 + filteredMentions.length) % filteredMentions.length,
              );
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              const item = filteredMentions[selectedMentionIndex];
              if (item) {
                e.preventDefault();
                insertMention(item);
                return;
              }
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMentionOpen(false);
              return;
            }
          }

          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        placeholder="Type and press enter to start chatting…"
        className={cn(
          "block w-full resize-none bg-transparent px-4 pt-4 pb-2",
          "text-[15px] leading-relaxed outline-none",
          "placeholder:text-muted-foreground/70",
          "max-h-[40dvh]",
        )}
      />

      <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1.5">
        <div className="flex items-center gap-1">
          <ToolButton label="Add files & mentions" disabled>
            <Plus size={16} />
          </ToolButton>
          <AutoToggle />
          <ModelPicker value="Default" />
        </div>

        <div className="flex items-center gap-1">
          <ToolButton label="Voice input" disabled>
            <Mic size={15} />
          </ToolButton>
          <button
            type="submit"
            disabled={!hasContent}
            aria-label="Send"
            className={cn(
              "inline-flex items-center justify-center size-8 rounded-full",
              "transition-colors",
              hasContent
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-muted text-muted-foreground/70 cursor-not-allowed",
            )}
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </form>
  );
}

function MentionMenu({
  items,
  selectedIndex,
  query,
  onSelect,
  onHover,
}: {
  items: MentionItem[];
  selectedIndex: number;
  query: string;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      className={cn(
        "absolute left-3 bottom-[calc(100%+0.5rem)] z-20",
        "w-[19rem] max-w-[calc(100vw-2rem)] rounded-2xl border bg-card/85",
        "backdrop-blur-md shadow-pop p-2",
        "animate-menu-pop-in origin-bottom-left",
      )}
    >
      <div className="max-h-80 overflow-y-auto scrollbar scroll-py-2">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm font-medium">No matches</p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              No integration matches @{query}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {items.map((item, index) => (
              <MentionMenuItem
                key={item.id}
                item={item}
                selected={index === selectedIndex}
                onMouseEnter={() => onHover(index)}
                onSelect={() => onSelect(item)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between px-2 py-1 text-[11px] text-muted-foreground/80">
        <span>@ mentions route the run through a tool</span>
        <span className="tabular">Enter</span>
      </div>
    </div>
  );
}

function MentionMenuItem({
  item,
  selected,
  onMouseEnter,
  onSelect,
}: {
  item: MentionItem;
  selected: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-selected={selected}
      onMouseEnter={onMouseEnter}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        "group flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2 py-2",
        "text-left text-sm outline-none transition-colors",
        selected ? "bg-accent/70 text-foreground" : "text-foreground hover:bg-accent/50",
      )}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg border bg-background/70",
          "text-muted-foreground shadow-soft",
        )}
      >
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.connected ? (
        <span className="rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          connected
        </span>
      ) : null}
    </button>
  );
}

/**
 * Bespoke neumorphic toggle for "Auto" mode. The dark-mode gradient mirrors
 * dimension's composer primitive (`#141414 → rgba(20,20,20,0.5)`); light mode
 * resolves through semantic tokens so it doesn't render as a near-black chip
 * on a near-white page. Decoration-only until m13 wires real toggle state.
 */
function AutoToggle() {
  return (
    <button
      type="button"
      disabled
      aria-pressed="true"
      title="Auto mode (boss model picks the agent)"
      className={cn(
        "inline-flex items-center justify-center h-[31px] min-w-[71px] px-3",
        "rounded-[10px] backdrop-blur-sm border border-foreground/10",
        "bg-muted/60 dark:bg-gradient-to-b dark:from-[#141414] dark:to-[#141414]/50",
        "text-[12px] font-medium tabular text-foreground/90",
        "transition-opacity disabled:cursor-not-allowed disabled:opacity-90",
      )}
    >
      Auto
    </button>
  );
}

/**
 * Model-picker chip. Semantic tiers only ("Default" / "Pro") — never provider
 * names. Disabled until m13/m14 land actual model routing.
 */
function ModelPicker({ value }: { value: string }) {
  return (
    <button
      type="button"
      disabled
      title="Model picker — lands with m13"
      className={cn(
        "inline-flex items-center gap-1 h-8 px-2.5 rounded-md",
        "text-[12px] font-medium text-muted-foreground",
        "hover:text-foreground hover:bg-accent/60",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-80",
      )}
    >
      {value}
      <ChevronDown size={12} className="opacity-70" />
    </button>
  );
}

function ChipLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-card/40",
        "px-3 py-1 text-[12px] text-muted-foreground",
        "hover:bg-accent/60 hover:text-foreground transition-colors",
      )}
    >
      <span className="opacity-80">{icon}</span>
      {children}
    </a>
  );
}

/* -------------------------------------------------------------------------- */

function HomeRightRail({
  longDate,
  healthOk,
  healthLoading,
}: {
  longDate: string;
  healthOk: boolean;
  healthLoading: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="px-4 py-3 border-b">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
          Today
        </p>
        <p className="text-[14px] font-medium mt-0.5">{longDate}</p>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar p-4 space-y-5">
        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
            Suggestions
          </p>
          <div className="rounded-md border bg-background/60 p-3 text-[12.5px] text-muted-foreground italic">
            Alfred will surface proactive suggestions here once integrations are connected and the
            boss agent is wired (m13).
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
            Morning briefing
          </p>
          <div className="rounded-md border bg-background/60 p-3 text-[12.5px] text-muted-foreground">
            Daily digest delivers each morning. Configure timezone & hour in Settings.
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
            Status
          </p>
          <div className="rounded-md border bg-background/60 p-3 text-[12px] space-y-1">
            <Row label="Server">
              {healthLoading ? (
                <span className="text-muted-foreground">checking…</span>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    healthOk ? "text-emerald-500" : "text-destructive",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      healthOk ? "bg-emerald-500" : "bg-destructive",
                    )}
                  />
                  {healthOk ? "online" : "offline"}
                </span>
              )}
            </Row>
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function displayName(user: SessionUser | null | undefined): string {
  if (!user) return "there";
  if (user.name && user.name.trim().length > 0) {
    const first = user.name.trim().split(/\s+/)[0];
    if (first) return first;
  }
  if (user.email) {
    const local = user.email.split("@")[0];
    if (local && local.length > 0) {
      return (
        local
          .replace(/[._-]+/g, " ")
          .split(" ")
          .map(capitalize)
          .filter(Boolean)
          .join(" ") || local
      );
    }
  }
  return "there";
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function filterMentions(query: string): MentionItem[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return MENTION_ITEMS;
  return MENTION_ITEMS.filter((item) => {
    const haystack = [item.label, ...item.aliases].join(" ").toLowerCase();
    return haystack.includes(normalized);
  });
}

function activeMentionToken(value: string, caret: number): { start: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const start = beforeCaret.lastIndexOf("@");
  if (start < 0) return null;
  const charBefore = start === 0 ? "" : value[start - 1];
  if (charBefore && !/\s/.test(charBefore)) return null;

  const query = beforeCaret.slice(start + 1);
  if (/[\s@]/.test(query)) return null;
  return { start, query };
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Re-ticks the "now" reference every minute so the greeting transitions
 * (morning → afternoon → evening) even if the tab stays open across the
 * boundary. Cheap; no animation, just a re-render.
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
