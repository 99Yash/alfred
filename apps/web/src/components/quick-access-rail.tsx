import {
  ArrowRight,
  CheckCircle2,
  CheckSquare2,
  ClipboardCheck,
  Clock,
  Mail,
  MapPin,
  Paperclip,
  Pencil,
  Plus,
  Users,
  Video,
} from "lucide-react";
import { useState, type ComponentType, type KeyboardEvent } from "react";
import { WeatherVideoSurface } from "~/components/weather-video-surface";
import { useWeather } from "~/hooks/use-weather";
import { useTodos } from "~/lib/replicache/use-todos";
import type { SyncedTodo } from "@alfred/sync";
import type { WeatherSnapshot } from "~/lib/weather";
import { cn } from "~/lib/utils";

type RailMode = "tasks" | "emails" | "meetings";

const RAIL_TABS: Array<{
  mode: RailMode;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}> = [
  { mode: "tasks", label: "To Do", icon: CheckSquare2 },
  { mode: "emails", label: "Emails", icon: Mail },
  { mode: "meetings", label: "Meetings", icon: Video },
];

interface EmailDraft {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  time: string;
}

interface MeetingItem {
  id: string;
  title: string;
  time: string;
  attendees: number;
  location?: string;
  video?: boolean;
}

const FIXTURE_EMAILS: ReadonlyArray<EmailDraft> = [
  {
    id: "e1",
    sender: "Anna Chen",
    subject: "Re: Q1 planning sync",
    preview: "Thanks for the recap — one follow-up on the migration milestones…",
    time: "8:14 AM",
  },
  {
    id: "e2",
    sender: "Stripe",
    subject: "Receipt for May invoice",
    preview: "Your payment of $79.00 was successful. View receipt or update billing…",
    time: "Yesterday",
  },
  {
    id: "e3",
    sender: "GitHub",
    subject: "PR #214 needs review",
    preview: "yash opened a pull request: Move triage worker to BullMQ queue…",
    time: "Yesterday",
  },
];

const FIXTURE_MEETINGS: ReadonlyArray<MeetingItem> = [
  {
    id: "m1",
    title: "Standup",
    time: "9:30 AM",
    attendees: 5,
    video: true,
  },
  {
    id: "m2",
    title: "Design review — onboarding",
    time: "11:00 AM",
    attendees: 3,
    video: true,
  },
  {
    id: "m3",
    title: "Coffee with Priya",
    time: "3:00 PM",
    attendees: 1,
    location: "Indigo, 2nd floor",
  },
];

export function QuickAccessRail() {
  const [mode, setMode] = useState<RailMode>("tasks");
  const { data: weather, isLoading: weatherLoading, isError: weatherError } = useWeather();
  const { todos, suggestions, createTodo, completeTodo, reopenTodo, promoteTodo } = useTodos();
  const [draft, setDraft] = useState("");
  const active = RAIL_TABS.find((tab) => tab.mode === mode) ?? RAIL_TABS[0]!;
  const onRailTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const currentIndex = RAIL_TABS.findIndex((tab) => tab.mode === mode);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + delta + RAIL_TABS.length) % RAIL_TABS.length;
    setMode(RAIL_TABS[nextIndex]!.mode);
  };

  const toggleTodo = (todo: SyncedTodo) => {
    void (todo.status === "done" ? reopenTodo(todo.id) : completeTodo(todo.id));
  };

  const acceptSuggestion = (suggestion: SyncedTodo) => {
    void promoteTodo(suggestion.id);
  };

  const addDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    void createTodo(trimmed);
    setDraft("");
  };

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden rounded-3xl text-white shadow-pop ring-1 ring-white/10">
      <WeatherVideoSurface condition={weather?.condition} isDay={weather?.isDay} />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.1),rgba(0,0,0,0.08)_28%,rgba(7,17,31,0.7)_100%)]" />
      <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.24),transparent)]" />

      <div className="relative flex min-h-0 flex-1 flex-col p-5 pb-0">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <WeatherLabel snapshot={weather} loading={weatherLoading} errored={weatherError} />
            <h2 className="mt-1 text-2xl font-medium tracking-[-0.04em]">{active.label}</h2>
          </div>

          <div
            role="tablist"
            aria-label="Quick access mode"
            aria-orientation="horizontal"
            tabIndex={-1}
            onKeyDown={onRailTabKeyDown}
            className="flex rounded-2xl bg-black/20 p-1 backdrop-blur-sm"
          >
            {RAIL_TABS.map((tab) => {
              const Icon = tab.icon;
              const selected = mode === tab.mode;
              return (
                <button
                  key={tab.mode}
                  type="button"
                  role="tab"
                  aria-label={tab.label}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setMode(tab.mode)}
                  className={cn(
                    "grid h-9 w-14 place-items-center rounded-[14px]",
                    "transition-[background-color,color,transform] active:scale-[0.96]",
                    selected
                      ? "bg-white/[0.12] text-white shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.14)]"
                      : "text-white/50 hover:text-white/90",
                  )}
                >
                  <Icon size={16} />
                </button>
              );
            })}
          </div>
        </header>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto scrollbar pb-1">
          {mode === "tasks" ? (
            <TasksPanel
              todos={todos}
              suggestions={suggestions}
              draft={draft}
              onDraftChange={setDraft}
              onAddDraft={addDraft}
              onToggleTodo={toggleTodo}
              onAcceptSuggestion={acceptSuggestion}
            />
          ) : null}
          {mode === "emails" ? <EmailsPanel emails={FIXTURE_EMAILS} /> : null}
          {mode === "meetings" ? <MeetingsPanel meetings={FIXTURE_MEETINGS} /> : null}
        </div>

        <a
          href="/workflows"
          aria-label="Open Morning Briefing"
          className={cn(
            "-mx-5 mt-auto flex h-[57px] items-center justify-between border-t border-white/5",
            "bg-black/[0.1] px-5 text-left text-base font-medium text-white",
            "transition-colors hover:bg-black/[0.15] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/[0.22]",
          )}
        >
          Morning Briefing
          <ArrowRight size={16} />
        </a>
      </div>
    </div>
  );
}

function TasksPanel({
  todos,
  suggestions,
  draft,
  onDraftChange,
  onAddDraft,
  onToggleTodo,
  onAcceptSuggestion,
}: {
  todos: ReadonlyArray<SyncedTodo>;
  suggestions: ReadonlyArray<SyncedTodo>;
  draft: string;
  onDraftChange: (next: string) => void;
  onAddDraft: () => void;
  onToggleTodo: (todo: SyncedTodo) => void;
  onAcceptSuggestion: (suggestion: SyncedTodo) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/20 pb-3">
        <button
          type="button"
          className={cn(
            "px-2 py-0.5 text-sm text-white transition-colors hover:text-white/90",
            "mix-blend-plus-lighter outline-none",
          )}
        >
          All
        </button>
        <button
          type="button"
          aria-label="Edit todos"
          className="grid size-8 place-items-center rounded-xl text-white/70 transition-[background-color,color,transform] hover:bg-white/10 hover:text-white active:scale-[0.96]"
        >
          <Pencil size={15} />
        </button>
      </div>

      <ul className="mt-2 space-y-0.5">
        {todos.map((todo) => {
          const done = todo.status === "done";
          return (
            <li key={todo.id}>
              <button
                type="button"
                onClick={() => onToggleTodo(todo)}
                aria-pressed={done}
                className={cn(
                  "flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                  "text-sm text-white/90 outline-none transition-colors",
                  "hover:bg-white/[0.05] focus-visible:bg-white/[0.06]",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border",
                    "transition-[background-color,border-color]",
                    done ? "border-white/60 bg-white/60" : "border-white/40 bg-transparent",
                  )}
                >
                  {done ? <CheckCircle2 size={10} className="text-black/70" /> : null}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 leading-5 transition-colors",
                    done && "text-white/50 line-through",
                  )}
                >
                  {todo.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div
        className={cn(
          "mt-1 flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-1",
          "text-left text-sm text-white/50 transition-colors hover:text-white/90",
        )}
      >
        <input
          type="checkbox"
          aria-label="Mark new todo complete"
          disabled
          className="mt-0.5 size-4 shrink-0 appearance-none rounded-[4px] border border-white/40 bg-transparent"
        />
        <textarea
          aria-label="Add new to do"
          placeholder="Add new to do"
          rows={1}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onAddDraft();
            }
          }}
          className="min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 text-white outline-none placeholder:text-white/50"
        />
      </div>

      {suggestions.length > 0 ? (
        <section className="mt-6">
          <div className="flex items-center gap-1.5">
            <ClipboardCheck size={11} className="text-white/60" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">
              Suggestions
            </p>
          </div>

          <ul className="mt-5 space-y-1 border-t border-white/20 pt-3">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id}>
                <button
                  type="button"
                  onClick={() => onAcceptSuggestion(suggestion)}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left",
                    "text-white outline-none transition-colors hover:bg-white/[0.06]",
                    "focus-visible:ring-2 focus-visible:ring-white/22",
                  )}
                >
                  <span className="mt-0.5 grid size-5 place-items-center rounded-md text-white/60 transition-colors group-hover:text-white">
                    <Plus size={14} />
                  </span>
                  <span className="max-w-[230px] text-sm leading-relaxed">{suggestion.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        todos.every((t) => t.status === "done") && (
          <div className="mt-6 border-t border-white/20 pt-5">
            <RailEmpty
              tone="muted"
              title="No new suggestions"
              text="Alfred will surface a follow-up the next time something needs your call."
            />
          </div>
        )
      )}
    </div>
  );
}

function EmailsPanel({ emails }: { emails: ReadonlyArray<EmailDraft> }) {
  if (emails.length === 0) {
    return <RailEmpty title="All done!" text="No pending email drafts." />;
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/20 pb-3">
        <button
          type="button"
          className="px-2 py-0.5 text-sm text-white mix-blend-plus-lighter outline-none transition-colors hover:text-white/90"
        >
          All
        </button>
        <span className="text-[11px] font-medium tabular text-white/60">
          {emails.length} drafts
        </span>
      </div>
      <ul className="mt-2 space-y-0.5">
        {emails.map((email) => (
          <li key={email.id}>
            <button
              type="button"
              className={cn(
                "group flex w-full flex-col gap-1 rounded-xl px-2 py-2 text-left",
                "outline-none transition-colors hover:bg-white/[0.06]",
                "focus-visible:ring-2 focus-visible:ring-white/[0.22]",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-white">{email.sender}</span>
                <span className="shrink-0 text-[11px] tabular text-white/50">{email.time}</span>
              </div>
              <span className="line-clamp-1 text-[12.5px] text-white/80">{email.subject}</span>
              <span className="line-clamp-1 text-[11.5px] text-white/55">{email.preview}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MeetingsPanel({ meetings }: { meetings: ReadonlyArray<MeetingItem> }) {
  if (meetings.length === 0) {
    return <RailEmpty title="All done!" text="You have no meetings scheduled for today." />;
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-white/20 pb-3">
        <button
          type="button"
          className="px-2 py-0.5 text-sm text-white mix-blend-plus-lighter outline-none transition-colors hover:text-white/90"
        >
          Today
        </button>
        <span className="text-[11px] font-medium tabular text-white/60">
          {meetings.length} scheduled
        </span>
      </div>
      <ul className="mt-2 space-y-0.5">
        {meetings.map((meeting) => (
          <li key={meeting.id}>
            <button
              type="button"
              className={cn(
                "group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left",
                "outline-none transition-colors hover:bg-white/[0.06]",
                "focus-visible:ring-2 focus-visible:ring-white/[0.22]",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg",
                  "bg-white/[0.08] text-white/80 ring-1 ring-inset ring-white/10",
                )}
              >
                {meeting.video ? <Video size={14} /> : <MapPin size={14} />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-white">{meeting.title}</span>
                  <span className="shrink-0 text-[11px] tabular text-white/55">{meeting.time}</span>
                </div>
                <div className="flex items-center gap-2 text-[11.5px] text-white/55">
                  <span className="inline-flex items-center gap-1">
                    <Users size={11} />
                    <span className="tabular">{meeting.attendees}</span>
                  </span>
                  {meeting.location ? (
                    <>
                      <span aria-hidden className="text-white/30">
                        ·
                      </span>
                      <span className="inline-flex items-center gap-1 truncate">
                        <MapPin size={11} />
                        <span className="truncate">{meeting.location}</span>
                      </span>
                    </>
                  ) : null}
                  {meeting.video && !meeting.location ? (
                    <>
                      <span aria-hidden className="text-white/30">
                        ·
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} />
                        <span>30 min</span>
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              <span
                aria-hidden
                className="mt-1 grid size-6 shrink-0 place-items-center rounded-md text-white/40 transition-colors group-hover:text-white/90"
              >
                <Paperclip size={12} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WeatherLabel({
  snapshot,
  loading,
  errored,
}: {
  snapshot: WeatherSnapshot | undefined;
  loading: boolean;
  errored: boolean;
}) {
  const wrapperClass =
    "flex h-[20px] items-center gap-1.5 text-sm font-bold tracking-[0.04em] text-white/60 mix-blend-plus-lighter";

  // Reserve the slot's height during load + error so the segmented
  // tablist below doesn't shift when the temp lands — but render
  // nothing visible. Previously the load state pulsed, which read as a
  // failure mode rather than "almost there" once geojs/open-meteo
  // started intermittently 4xx-ing from the browser.
  if (loading || errored || !snapshot) {
    return <div className={wrapperClass} aria-hidden />;
  }
  return (
    <div
      className={wrapperClass}
      aria-label={`${snapshot.temperature} degrees ${snapshot.unit} in ${snapshot.city}`}
    >
      <span className="truncate">{snapshot.city}</span>
      <span className="tabular">{snapshot.temperature}°</span>
    </div>
  );
}

function RailEmpty({
  title,
  text,
  tone = "default",
}: {
  title: string;
  text: string;
  tone?: "default" | "muted";
}) {
  return (
    <div
      className={cn(
        "grid place-items-center text-center",
        tone === "muted" ? "min-h-[120px]" : "min-h-[280px]",
      )}
    >
      <div className="flex flex-col items-center">
        <CheckCircle2
          size={tone === "muted" ? 28 : 40}
          strokeWidth={1.5}
          className="text-white/80 mix-blend-plus-lighter"
        />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-[12px] text-white/60">{text}</p>
      </div>
    </div>
  );
}
