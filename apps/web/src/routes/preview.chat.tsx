import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  BookOpen,
  Brain,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Ellipsis,
  Inbox,
  ListChecks,
  Mail,
  Mic,
  PanelRight,
  Paperclip,
  Plus,
  Share2,
  Sparkles,
  Sun,
  Tag,
  Users2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { VsPill, VsSegmented } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import { useChatContext } from "~/components/preview/chat-context";

/**
 * Visitors-now-grammar app shell for the upcoming chat UI.
 *
 * Layout
 * - Fixed 264px left rail: brand · new-chat CTA · search · thread groups · user.
 * - Main column: frost-blurred top bar with thread title + actions, scrollable
 *   conversation, composer pinned to bottom.
 *
 * Everything visitors-feel: rounded-full pills for nav rows, `vs-elevated`
 * surfaces, the masked frost backdrop on chrome, and active:scale-99 press.
 * Theme-aware via VsThemeProvider — toggle lives in the top bar.
 *
 * Mounted at /preview/chat regardless of auth state. Content below the chrome
 * is placeholder so the shell can be reviewed in isolation before /chat lands.
 */
export const Route = createFileRoute("/preview/chat")({
  component: PreviewChatRoute,
});

function PreviewChatRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewChatPage />;
}

export { PreviewChatPage };

type ThreadGroup = "today" | "yesterday" | "earlier";

interface ThreadEntry {
  id: string;
  title: string;
  preview: string;
  pinned?: boolean;
  unread?: boolean;
}

const THREADS: Record<ThreadGroup, ThreadEntry[]> = {
  today: [
    {
      id: "morning-brief",
      title: "Morning briefing — Friday",
      preview: "Three threads to look at, calendar starts at 10.",
      pinned: true,
    },
    {
      id: "sycamore-recap",
      title: "Sycamore investor update",
      preview: "Pull last three sends and summarize the asks.",
    },
    {
      id: "calendar-block",
      title: "Block focus time tomorrow",
      preview: "Two free 90-min windows on the calendar.",
      unread: true,
    },
  ],
  yesterday: [
    {
      id: "triage-rules",
      title: "Tune triage label rules",
      preview: "Move newsletters off the inbox tab.",
    },
    {
      id: "vesting-q",
      title: "Vesting cliff question",
      preview: "Draft response to Maya's email.",
    },
  ],
  earlier: [
    {
      id: "weekly-recap",
      title: "Weekly recap — week 21",
      preview: "Highlights, blockers, decisions made.",
    },
    {
      id: "cold-start",
      title: "Cold-start research notes",
      preview: "Pull facts from initial Sonar pass.",
    },
    {
      id: "memory-cleanup",
      title: "Memory cleanup pass",
      preview: "Remove stale auth-flow notes.",
    },
  ],
};

function PreviewChatPage() {
  const { activeThread } = useChatContext();
  const [composer, setComposer] = useState("");
  const railMode = useRailMode();
  const [railOpen, setRailOpen] = useState(() => railMode === "inline");

  // When the viewport crosses the rail breakpoint, snap the rail to that
  // mode's sensible default: wide screens show it, narrow screens hide it.
  const prevMode = useRef(railMode);
  useEffect(() => {
    if (prevMode.current !== railMode) {
      setRailOpen(railMode === "inline");
      prevMode.current = railMode;
    }
  }, [railMode]);

  // ESC closes the overlay rail.
  useEffect(() => {
    if (railMode !== "overlay" || !railOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [railMode, railOpen]);

  const activeEntry = findThread(activeThread);

  // Sidebar + theme provider are owned by `preview.tsx`. This route only
  // contributes the main column + right rail, rendered as siblings of the
  // sidebar inside the layout's outer flex container.
  return (
    <>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ThreadTopBar
          title={activeEntry?.title ?? "New chat"}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((v) => !v)}
        />

        <ConversationScroll>
          <ConversationPlaceholder entry={activeEntry} />
        </ConversationScroll>

        <ComposerDock value={composer} onChange={setComposer} />
      </div>

      <RightRail open={railOpen} mode={railMode} onClose={() => setRailOpen(false)} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Right rail — Today panel                                                    */
/*                                                                            */
/* Two layout modes driven by viewport width:                                 */
/*  • inline  (≥1280px): takes column space next to the conversation.         */
/*  • overlay (<1280px): slides in over the conversation with a backdrop.     */
/* The mode swap auto-syncs `railOpen` to each mode's sensible default so a   */
/* resize doesn't leave the user looking at a giant fullscreen overlay.       */
/* -------------------------------------------------------------------------- */

type RailMode = "inline" | "overlay";
type RailTab = "todo" | "inbox" | "meetings";

const RAIL_BREAKPOINT = "(min-width: 1280px)";

function useRailMode(): RailMode {
  const [mode, setMode] = useState<RailMode>(() => {
    if (typeof window === "undefined") return "inline";
    return window.matchMedia(RAIL_BREAKPOINT).matches ? "inline" : "overlay";
  });
  useEffect(() => {
    const mq = window.matchMedia(RAIL_BREAKPOINT);
    const handler = () => setMode(mq.matches ? "inline" : "overlay");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mode;
}

interface TodoItem {
  id: string;
  title: string;
  due?: string;
  source?: "email" | "meeting" | "manual";
  done?: boolean;
}

const TODOS: TodoItem[] = [
  {
    id: "maya-reply",
    title: "Reply to Maya — vesting cliff question",
    due: "Today",
    source: "email",
  },
  {
    id: "sycamore-recap",
    title: "Send Sycamore investor recap",
    due: "Today",
    source: "email",
  },
  {
    id: "linear-renewal",
    title: "Decide on Linear vendor renewal",
    due: "Tomorrow",
  },
  {
    id: "focus-friday",
    title: "Block focus time Friday",
    source: "meeting",
  },
  {
    id: "fatca",
    title: "Submit FATCA/CRS forms",
    due: "May 26",
    done: true,
  },
];

interface InboxItem {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  time: string;
  unread?: boolean;
  initial: string;
  tone: ToolTone;
}

const INBOX: InboxItem[] = [
  {
    id: "maya",
    sender: "Maya Chen",
    subject: "Re: vesting cliff",
    preview: "Quick question on the 4-yr — does the…",
    time: "8m",
    unread: true,
    initial: "M",
    tone: "purple",
  },
  {
    id: "sycamore",
    sender: "Sycamore Capital",
    subject: "Quarterly investor update",
    preview: "Hi team — wanted to check in on the…",
    time: "1h",
    unread: true,
    initial: "S",
    tone: "sky",
  },
  {
    id: "linear",
    sender: "Linear",
    subject: "Renewal notice",
    preview: "Your team plan renews on June 14…",
    time: "3h",
    initial: "L",
    tone: "amber",
  },
  {
    id: "github",
    sender: "GitHub",
    subject: "3 PRs need your review",
    preview: "alfred/m13-agent-bridge-followup…",
    time: "5h",
    initial: "G",
    tone: "green",
  },
];

interface MeetingItem {
  id: string;
  title: string;
  time: string;
  duration: string;
  with: string;
  status?: "now" | "next" | "later";
}

const MEETINGS: MeetingItem[] = [
  {
    id: "eng-sync",
    title: "Eng sync",
    time: "10:00",
    duration: "30m",
    with: "5 people",
    status: "next",
  },
  {
    id: "priya",
    title: "1:1 with Priya",
    time: "11:30",
    duration: "30m",
    with: "Priya R.",
  },
  {
    id: "sycamore-call",
    title: "Sycamore investor call",
    time: "14:00",
    duration: "45m",
    with: "3 people",
  },
];

const RAIL_TABS: ReadonlyArray<{ value: RailTab; label: string; icon: ReactNode }> = [
  { value: "todo", label: "To do", icon: <ListChecks size={12} /> },
  { value: "inbox", label: "Inbox", icon: <Mail size={12} /> },
  { value: "meetings", label: "Up next", icon: <CalendarClock size={12} /> },
];

interface RightRailProps {
  open: boolean;
  mode: RailMode;
  onClose: () => void;
}

function RightRail({ open, mode, onClose }: RightRailProps) {
  const [tab, setTab] = useState<RailTab>("todo");

  if (mode === "overlay") {
    return (
      <>
        <button
          type="button"
          aria-label="Close panel"
          tabIndex={open ? 0 : -1}
          onClick={onClose}
          className={cn(
            "fixed inset-0 z-40 bg-vs-background/40 backdrop-blur-[2px]",
            "transition-opacity duration-200",
            open ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        />
        <aside
          aria-label="Today"
          aria-hidden={!open}
          className={cn(
            "fixed top-0 right-0 bottom-0 z-50 w-[340px] max-w-[88vw]",
            "border-l border-vs-bg-3/60 bg-vs-bg-1",
            "flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
            "transition-transform duration-200 ease-out",
            "overflow-hidden",
            open ? "translate-x-0" : "translate-x-full",
          )}
        >
          <RailContent tab={tab} onTabChange={setTab} onClose={onClose} showClose />
        </aside>
      </>
    );
  }

  return (
    <aside
      aria-label="Today"
      className={cn(
        "shrink-0 h-full",
        "rounded-2xl bg-vs-bg-1",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
        "transition-[width] duration-200 ease-out overflow-hidden",
        open ? "w-[340px]" : "w-0",
      )}
    >
      <div className="relative h-full w-[340px] flex flex-col">
        <RailContent tab={tab} onTabChange={setTab} />
      </div>
    </aside>
  );
}

function RailContent({
  tab,
  onTabChange,
  onClose,
  showClose = false,
}: {
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  onClose?: () => void;
  showClose?: boolean;
}) {
  return (
    <>
      <RailAtmosphere />

      <div className="relative z-10 flex h-full min-h-0 flex-col">
        {/* Header — greeting on the left, weather chip on the right. The
         * weather chip is the dimension-style atmospheric touch: a soft
         * surface plate floating above the rail's radial glow. */}
        <div className="px-4 pt-5 pb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium tracking-tight text-vs-fg-4">
              Good morning
            </div>
            <div className="mt-1 text-[11.5px] uppercase tracking-tight font-medium text-vs-fg-2">
              Friday · May 23
            </div>
          </div>
          <div className="flex items-start gap-1.5 shrink-0">
            <WeatherChip />
            {showClose ? (
              <button
                type="button"
                aria-label="Close panel"
                onClick={onClose}
                className={cn(
                  "size-7 inline-flex items-center justify-center rounded-lg",
                  "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4 transition-colors vs-press",
                  "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
                )}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="px-4 pb-3">
          <VsSegmented<RailTab>
            value={tab}
            onValueChange={onTabChange}
            items={RAIL_TABS}
            label="Today filter"
          />
        </div>

        {/* Stacked feeds — all three render in the same grid cell so the
         * outgoing feed crossfades + lifts while the new feed settles in.
         * Same pattern as `HeroShowcase`'s `Slot`. The scroll container's
         * height is the MAX of all feeds, so a tab swap never re-flows
         * the rail. */}
        <div
          className={cn(
            "relative flex-1 min-h-0 overflow-y-auto vs-scrollbar px-3 pb-3",
            "[scrollbar-width:thin]",
          )}
        >
          <div className="relative grid">
            <RailSlot active={tab === "todo"}>
              <TodoFeed />
            </RailSlot>
            <RailSlot active={tab === "inbox"}>
              <InboxFeed />
            </RailSlot>
            <RailSlot active={tab === "meetings"}>
              <MeetingsFeed />
            </RailSlot>
          </div>
        </div>

        <RailFooter />
      </div>
    </>
  );
}

/**
 * Soft radial atmosphere behind the rail header. Two stacked gradients:
 * a warm amber sunrise near the top-right (under the weather chip) and a
 * cooler violet ambient near the top-left. Mirrors the landing's
 * `AuroraGlow` shape but is tuned tighter and softer because this is a
 * 340px rail, not a hero. Pointer-events-none, sits at z-0 under the
 * rail content.
 */
function RailAtmosphere() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[320px] z-0 overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 70% at 78% 0%, rgba(251, 191, 36, 0.18) 0%, rgba(251, 191, 36, 0.05) 38%, transparent 68%)",
          filter: "blur(8px)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 65% at 18% 8%, rgba(167, 139, 250, 0.18) 0%, rgba(139, 92, 246, 0.04) 45%, transparent 70%)",
          filter: "blur(9px)",
        }}
      />
    </div>
  );
}

/**
 * Compact weather widget. Dimension placed `Bhubaneswar 29°` in the rail's
 * top-right; we mirror that with a subtle surface plate that sits on top of
 * the atmosphere glow. Mock data only — wiring to a real weather provider
 * is out of scope for the rail preview.
 */
function WeatherChip() {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full h-7 pl-2 pr-2.5",
        "bg-vs-bg-1/70 ring-1 ring-vs-bg-3/70 backdrop-blur",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
      )}
    >
      <Sun size={12} className="text-vs-amber-4" aria-hidden />
      <span className="text-[12px] font-medium text-vs-fg-4 tabular-nums">27°</span>
      <span aria-hidden className="h-3 w-px bg-vs-bg-3/80" />
      <span className="text-[11px] text-vs-fg-2">Bengaluru</span>
    </div>
  );
}

/**
 * One stacked feed in the rail's tab grid. Inactive slots fade + lift +
 * blur, and lose pointer events so they don't intercept clicks meant for
 * the visible feed below. Crossfade timing matches the landing showcase.
 */
function RailSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "[grid-area:1/1] transition-[opacity,transform,filter] duration-300 ease-out",
        active ? "opacity-100 z-10" : "opacity-0 pointer-events-none blur-[2px]",
      )}
      style={{
        transform: active ? "translateY(0) scale(1)" : "translateY(8px) scale(0.985)",
      }}
    >
      {children}
    </div>
  );
}

function TodoFeed() {
  const open = TODOS.filter((t) => !t.done);
  const done = TODOS.filter((t) => t.done);

  return (
    <div className="vs-card-in space-y-4 px-1 pt-1">
      <ul className="space-y-0.5">
        {open.map((todo) => (
          <TodoRow key={todo.id} todo={todo} />
        ))}
      </ul>

      <RailAddRow placeholder="Add a to-do…" />

      {done.length ? (
        <div className="pt-1">
          <div className="px-2 pb-1.5 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
            Done
          </div>
          <ul className="space-y-0.5">
            {done.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </ul>
        </div>
      ) : null}

      <RailSection title="Suggestions">
        <SuggestionRow
          label="Draft reply to Sycamore"
          detail="Pull last 3 sends · summarize asks"
        />
        <SuggestionRow
          label="Tag newsletters as Later"
          detail="12 threads from this morning"
        />
      </RailSection>
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 rounded-md inline-flex items-center justify-center",
            "border transition-colors",
            todo.done
              ? "bg-vs-purple-4 border-vs-purple-4 text-white"
              : "border-vs-bg-3 group-hover:border-vs-fg-2 bg-transparent",
          )}
        >
          {todo.done ? <Check size={10} strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-[13px] leading-5 font-medium",
              todo.done ? "text-vs-fg-2 line-through" : "text-vs-fg-4",
            )}
          >
            {todo.title}
          </span>
          {todo.due || todo.source ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-vs-fg-2">
              {todo.source === "email" ? (
                <Mail size={10} className="text-vs-sky-4" aria-hidden />
              ) : null}
              {todo.source === "meeting" ? (
                <Calendar size={10} className="text-vs-amber-4" aria-hidden />
              ) : null}
              {todo.due ? <span>{todo.due}</span> : null}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function InboxFeed() {
  const unread = INBOX.filter((i) => i.unread).length;
  return (
    <div className="vs-card-in space-y-2">
      <div className="px-1 flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
          Unread · {unread}
        </span>
        <button
          type="button"
          className="text-[11px] text-vs-fg-3 hover:text-vs-fg-4 transition-colors"
        >
          Mark all read
        </button>
      </div>
      <ul className="space-y-0.5">
        {INBOX.map((item) => (
          <InboxRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 size-7 shrink-0 rounded-full inline-flex items-center justify-center",
            "text-[11px] font-semibold tabular-nums",
            TOOL_TONE[item.tone],
          )}
        >
          {item.initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 truncate text-[13px] leading-5",
                item.unread ? "font-medium text-vs-fg-4" : "text-vs-fg-3",
              )}
            >
              {item.sender}
            </span>
            {item.unread ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-vs-purple-4" />
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] text-vs-fg-2 tabular-nums">
              {item.time}
            </span>
          </span>
          <span
            className={cn(
              "block truncate text-[12px] leading-4",
              item.unread ? "text-vs-fg-3" : "text-vs-fg-2",
            )}
          >
            {item.subject}
          </span>
          <span className="block truncate text-[11px] leading-4 text-vs-fg-2">
            {item.preview}
          </span>
        </span>
      </button>
    </li>
  );
}

function MeetingsFeed() {
  return (
    <div className="vs-card-in space-y-2">
      <div className="px-1 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
        Today · {MEETINGS.length}
      </div>
      <ul className="space-y-1">
        {MEETINGS.map((meeting) => (
          <MeetingRow key={meeting.id} meeting={meeting} />
        ))}
      </ul>

      <RailSection title="After today">
        <SuggestionRow label="Mon · Board prep with Priya" detail="09:30 · 60m" />
        <SuggestionRow label="Tue · Vendor demo" detail="14:00 · 45m" />
      </RailSection>
    </div>
  );
}

function MeetingRow({ meeting }: { meeting: MeetingItem }) {
  const isNext = meeting.status === "next";
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 inline-flex flex-col items-center justify-center shrink-0 rounded-md",
            "h-10 w-10 leading-none",
            isNext
              ? "bg-vs-amber-1 text-vs-amber-4 ring-1 ring-vs-amber-2"
              : "bg-vs-bg-2 text-vs-fg-3",
          )}
        >
          <span className="text-[11px] font-semibold tabular-nums">{meeting.time}</span>
          <span className="mt-0.5 text-[9px] uppercase tracking-tight text-vs-fg-2">
            {meeting.duration}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-5 font-medium text-vs-fg-4">
              {meeting.title}
            </span>
            {isNext ? (
              <span
                aria-hidden
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5",
                  "text-[9.5px] uppercase tracking-tight font-medium",
                  "bg-vs-amber-1 text-vs-amber-4",
                )}
              >
                Next
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[11px] leading-4 text-vs-fg-2">
            {meeting.with}
          </span>
        </span>
      </button>
    </li>
  );
}

function RailAddRow({ placeholder }: { placeholder: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "border border-dashed border-vs-bg-3 hover:border-vs-fg-2",
        "transition-colors flex items-center gap-2",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      <Plus
        size={12}
        aria-hidden
        className="text-vs-fg-2 group-hover:text-vs-fg-4 transition-colors"
      />
      <span className="text-[12px] text-vs-fg-2 group-hover:text-vs-fg-3 transition-colors">
        {placeholder}
      </span>
    </button>
  );
}

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pt-3">
      <div className="px-1 pb-1.5 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SuggestionRow({ label, detail }: { label: string; detail: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "hover:bg-vs-bg-a2 transition-colors vs-press",
        "flex items-center gap-2.5",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] leading-5 font-medium text-vs-fg-4">
          {label}
        </span>
        <span className="block truncate text-[11px] leading-4 text-vs-fg-2">{detail}</span>
      </span>
      <ChevronRight
        size={12}
        aria-hidden
        className="shrink-0 text-vs-fg-2 group-hover:text-vs-fg-3 transition-colors"
      />
    </button>
  );
}

function RailFooter() {
  return (
    <div className="shrink-0 p-3 border-t border-vs-bg-3/60">
      <button
        type="button"
        className={cn(
          "w-full inline-flex items-center justify-between gap-2 rounded-xl h-10 px-3",
          "text-sm font-medium",
          "text-[var(--vs-accent-fg)]",
          "bg-[image:var(--vs-cta-bg)]",
          "shadow-[var(--vs-button-primary-shadow)]",
          "vs-press transition-[box-shadow,transform,filter]",
          "hover:brightness-[1.06]",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span className="inline-flex items-center gap-2">
          <Sparkles size={13} aria-hidden />
          Morning briefing
        </span>
        <ArrowRight size={14} aria-hidden />
      </button>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/* Top bar                                                                     */
/* -------------------------------------------------------------------------- */

function ThreadTopBar({
  title,
  railOpen,
  onToggleRail,
}: {
  title: string;
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  return (
    <div
      className={cn(
        "vs-frost-header sticky top-0 z-30",
        "h-[58px] px-4 flex items-center justify-between gap-3",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-sm font-medium tracking-tight text-vs-fg-4 truncate max-w-[42ch]">{title}</h1>
        <VsPill className="h-7 px-2 text-[12px]" tone="purple" variant="accent">
          Boss agent
        </VsPill>
      </div>

      <div className="flex items-center gap-1.5">
        <IconButton label="Share thread">
          <Share2 size={14} />
        </IconButton>
        <IconButton label="Thread settings">
          <Ellipsis size={14} />
        </IconButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-vs-bg-3" />
        <IconButton
          label={railOpen ? "Hide today panel" : "Show today panel"}
          onClick={onToggleRail}
          active={railOpen}
        >
          <PanelRight size={14} />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  label,
  children,
  onClick,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
      className={cn(
        "size-8 inline-flex items-center justify-center rounded-lg",
        "transition-colors vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        active
          ? "bg-vs-bg-2 text-vs-fg-4 hover:bg-vs-bg-a2"
          : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Conversation area                                                           */
/* -------------------------------------------------------------------------- */

function ConversationScroll({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto vs-scrollbar">
      <div className="mx-auto w-full max-w-3xl px-6 pt-10 pb-8">{children}</div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none sticky bottom-0 left-0 right-0 h-10",
          "bg-gradient-to-t from-vs-background to-transparent",
        )}
      />
    </div>
  );
}

function ConversationPlaceholder({ entry }: { entry: ThreadEntry | undefined }) {
  if (!entry) {
    return <EmptyConversation />;
  }
  return (
    <div className="space-y-8 vs-card-in">
      <UserTurn text={entry.preview} />
      <AssistantTurn />
      <UserTurn text="Skip the calendar bit — just the email summary, ranked by who's waiting on me." />
      <AssistantTurn followUp />
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col items-center justify-center text-center pt-24 vs-card-in">
      <span
        aria-hidden
        className="size-12 rounded-full inline-flex items-center justify-center bg-vs-purple-1 text-vs-purple-4 mb-3"
      >
        <Sparkles size={18} />
      </span>
      <h2 className="text-base font-medium tracking-tight text-vs-fg-4">Ask Alfred anything</h2>
      <p className="mt-1 max-w-sm text-sm text-vs-fg-3">
        Search your mail, summarize a thread, draft a reply, or kick off a workflow.
      </p>
    </div>
  );
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[80%] rounded-2xl rounded-tr-md px-4 py-2.5 text-sm",
          "bg-vs-bg-2 text-vs-fg-4",
        )}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantTurn({ followUp = false }: { followUp?: boolean }) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 size-7 shrink-0 rounded-full bg-vs-purple-1 text-vs-purple-4 inline-flex items-center justify-center"
      >
        <Sparkles size={13} />
      </span>
      <div className="flex-1 min-w-0 space-y-4 text-sm text-vs-fg-3 leading-relaxed">
        {followUp ? (
          <>
            <RunGroup title="Sorted inbox by who's waiting" itemCount={5}>
              <ThoughtRow duration="2s">
                The user wants just emails ranked by reply urgency, skipping the calendar pull.
              </ThoughtRow>
              <SearchRow
                icon={Mail}
                tone="sky"
                label="Filtered Gmail"
                detail="from:* in:inbox -label:later"
                count="7 threads"
              />
              <ToolRow
                icon={Users2}
                tone="purple"
                label="Resolved senders"
                detail="3 of 7 are recurring contacts"
              />
              <ThoughtRow duration="1s">
                Ranked by latest-reply-from-me age: older threads first.
              </ThoughtRow>
              <ToolRow
                icon={Tag}
                tone="green"
                label="Tagged 3 as Reply today"
                done
              />
            </RunGroup>
            <p>
              <span className="text-vs-fg-4 font-medium">Three to answer.</span> Maya's vesting
              question (waiting 2 days), the Sycamore investor recap (their ask is on the cliff
              date), and a vendor renewal from Linear.
            </p>
            <p>The newsletters and three notifications have been auto-archived to Later.</p>
            <SourcesRow
              items={[
                { icon: Inbox, label: "Inbox", count: 7, tone: "sky" },
                { icon: Users2, label: "Contacts", count: 3, tone: "purple" },
              ]}
            />
          </>
        ) : (
          <>
            <RunGroup title="Reviewed your morning" itemCount={6}>
              <ThoughtRow duration="2s">
                Pulling unread Gmail threads since yesterday and Friday's calendar blocks.
              </ThoughtRow>
              <SearchRow
                icon={Mail}
                tone="sky"
                label="Searched Gmail"
                detail="is:unread newer_than:1d"
                count="8 threads"
              />
              <ToolRow
                icon={BookOpen}
                tone="purple"
                label="Read 3 threads"
                detail="Maya, Sycamore, Linear"
              />
              <ThoughtRow duration="1s">
                Now the calendar: three blocks today plus a tentative.
              </ThoughtRow>
              <SearchRow
                icon={Calendar}
                tone="amber"
                label="Listed today's events"
                detail="2026-05-23 · primary calendar"
                count="3 events"
              />
              <ToolRow
                icon={Brain}
                tone="pink"
                label="Recalled context"
                detail="2 memory hits about Sycamore"
                done
              />
            </RunGroup>
            <p>
              Here's your morning. You have{" "}
              <span className="text-vs-fg-4 font-medium">8 unread</span> threads, three of which
              need a reply today. Calendar starts at{" "}
              <span className="text-vs-fg-4 font-medium">10:00</span> with the eng sync.
            </p>
            <SourcesRow
              items={[
                { icon: Inbox, label: "Inbox", count: 8, tone: "sky" },
                { icon: Calendar, label: "Calendar", count: 3, tone: "amber" },
                { icon: Brain, label: "Memory", count: 2, tone: "pink" },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tool-call primitives — compact inline tree.                                */
/*                                                                            */
/* No surface card around the group: the run lives directly in the assistant  */
/* turn's text flow so it stays visually quiet, like a typed-out trace rather */
/* than a separate object. Chevron + title + steps count on the header line;  */
/* a thin vertical hairline guides the eye down the nested rows. Each row     */
/* carries a small `size-6 rounded-md` hue-tinted icon tile + label + optional */
/* right-aligned detail/count/check.                                          */
/* -------------------------------------------------------------------------- */

type ToolTone = "sky" | "amber" | "purple" | "green" | "pink" | "orange";

const TOOL_TONE: Record<ToolTone, string> = {
  sky: "bg-vs-sky-1 text-vs-sky-4",
  amber: "bg-vs-amber-1 text-vs-amber-4",
  purple: "bg-vs-purple-1 text-vs-purple-4",
  green: "bg-vs-green-1 text-vs-green-4",
  pink: "bg-vs-pink-1 text-vs-pink-4",
  orange: "bg-vs-orange-1 text-vs-orange-4",
};

function RunGroup({
  title,
  itemCount,
  defaultOpen = true,
  children,
}: {
  title: string;
  itemCount?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="-mx-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "group/run flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={cn(
            "shrink-0 text-vs-fg-2 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        <span className="text-sm font-medium text-vs-fg-4">{title}</span>
        {typeof itemCount === "number" ? (
          <span className="ml-auto text-xs text-vs-fg-2 tabular-nums">
            {itemCount} {itemCount === 1 ? "step" : "steps"}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="relative ml-[7px] mt-1.5 pl-5 pb-1">
          <span
            aria-hidden
            className="absolute left-0 top-1.5 bottom-2.5 w-px bg-vs-bg-3"
          />
          <div className="space-y-1.5">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({
  icon: Icon,
  tone,
  label,
  detail,
  count,
  done = false,
}: {
  icon: LucideIcon;
  tone: ToolTone;
  label: string;
  detail?: string;
  count?: string;
  done?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm leading-5">
      <span
        aria-hidden
        className={cn(
          "size-6 shrink-0 inline-flex items-center justify-center rounded-md",
          TOOL_TONE[tone],
        )}
      >
        <Icon size={12} />
      </span>
      <span className="min-w-0 truncate text-vs-fg-4 font-medium">{label}</span>
      {detail ? (
        <span className="hidden sm:inline truncate text-xs text-vs-fg-2 max-w-[28ch]">
          {detail}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {count ? (
          <span className="text-xs text-vs-fg-3 tabular-nums">{count}</span>
        ) : null}
        {done ? (
          <CheckCircle2 size={13} aria-hidden className="text-vs-green-4" />
        ) : null}
      </span>
    </div>
  );
}

function SearchRow(props: Omit<React.ComponentProps<typeof ToolRow>, "done">) {
  return <ToolRow {...props} done />;
}

function ThoughtRow({
  duration,
  children,
  defaultOpen = false,
}: {
  duration: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "group/th flex items-center gap-2 text-sm leading-5",
          "outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className="size-6 shrink-0 inline-flex items-center justify-center rounded-md bg-vs-bg-2 text-vs-fg-3"
        >
          <Sparkles size={12} />
        </span>
        <span className="text-vs-fg-3">
          Thought for <span className="text-vs-fg-4 font-medium">{duration}</span>
        </span>
        <ChevronRight
          size={12}
          aria-hidden
          className={cn(
            "shrink-0 text-vs-fg-2 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <p className="ml-8 mt-1.5 max-w-[64ch] text-xs leading-5 text-vs-fg-3">{children}</p>
      ) : null}
    </div>
  );
}

interface SourceItem {
  icon: LucideIcon;
  label: string;
  count: number;
  tone: ToolTone;
}

function SourcesRow({ items }: { items: SourceItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[11px] uppercase tracking-tight text-vs-fg-2 mr-1">Sources</span>
      {items.map((item) => (
        <SourcePill
          key={item.label}
          icon={<item.icon size={11} />}
          label={item.label}
          count={item.count}
          tone={item.tone}
        />
      ))}
    </div>
  );
}

function SourcePill({
  icon,
  label,
  count,
  tone,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  tone: ToolTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg h-6 px-2 text-[11px] font-medium",
        TOOL_TONE[tone],
      )}
    >
      {icon}
      {label}
      <span className="text-vs-fg-2 tabular-nums">{count}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Composer                                                                    */
/* -------------------------------------------------------------------------- */

const ADD_TOOL_LEADING = <Plus size={12} />;

function ComposerDock({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const canSend = value.trim().length > 0;
  return (
    <div className="shrink-0 pb-5 pt-1">
      <div className="mx-auto w-full max-w-3xl px-6">
        <div className={cn("rounded-3xl bg-vs-bg-1 p-2 vs-elevated")}>
          <textarea
            aria-label="Ask Alfred"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Ask Alfred…"
            rows={2}
            className={cn(
              "block w-full resize-none bg-transparent px-2.5 pt-2 text-sm text-vs-fg-4 placeholder:text-vs-fg-2",
              "outline-none focus-visible:outline-none",
            )}
          />

          <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
            <div className="flex items-center gap-1.5">
              <ComposerIcon label="Attach file">
                <Paperclip size={14} />
              </ComposerIcon>
              <ComposerIcon label="Mention source">
                <AtSign size={14} />
              </ComposerIcon>
              <VsPill className="h-7 px-2.5 text-[12px]" leading={ADD_TOOL_LEADING} chevron>
                Add tool
              </VsPill>
            </div>

            <div className="flex items-center gap-1.5">
              <ComposerIcon label="Dictate">
                <Mic size={14} />
              </ComposerIcon>
              <button
                type="button"
                disabled={!canSend}
                aria-label="Send message"
                className={cn(
                  "size-8 inline-flex items-center justify-center rounded-lg",
                  "vs-press transition-[box-shadow,transform,filter]",
                  "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
                  canSend
                    ? cn(
                        "text-[var(--vs-accent-fg)]",
                        "bg-[image:var(--vs-cta-bg)]",
                        "shadow-[var(--vs-button-primary-shadow)]",
                        "hover:brightness-[1.06]",
                      )
                    : "bg-vs-bg-2 text-vs-fg-2 cursor-not-allowed",
                )}
              >
                <ArrowUp size={15} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-vs-fg-2">
          Alfred can call tools across Gmail, Calendar, and your memory.
        </p>
      </div>
    </div>
  );
}

function ComposerIcon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "size-8 inline-flex items-center justify-center rounded-lg",
        "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4 transition-colors vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers + tiny icons                                                        */
/* -------------------------------------------------------------------------- */

function findThread(id: string): ThreadEntry | undefined {
  for (const group of Object.values(THREADS)) {
    const hit = group.find((t) => t.id === id);
    if (hit) return hit;
  }
  return undefined;
}
