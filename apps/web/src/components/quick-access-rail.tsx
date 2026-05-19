import {
  ArrowRight,
  CheckSquare2,
  ClipboardCheck,
  Mail,
  PartyPopper,
  Pencil,
  Video,
} from "lucide-react";
import { useState, type ComponentType, type KeyboardEvent } from "react";
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

export function QuickAccessRail({
  healthOk,
  healthLoading,
}: {
  healthOk: boolean;
  healthLoading: boolean;
}) {
  const [mode, setMode] = useState<RailMode>("tasks");
  const active = RAIL_TABS.find((tab) => tab.mode === mode) ?? RAIL_TABS[0]!;
  const onRailTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const currentIndex = RAIL_TABS.findIndex((tab) => tab.mode === mode);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + delta + RAIL_TABS.length) % RAIL_TABS.length;
    setMode(RAIL_TABS[nextIndex]!.mode);
  };

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden rounded-3xl text-white shadow-pop ring-1 ring-white/10">
      <div className="dimension-weather-surface absolute inset-0" />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.1),rgba(0,0,0,0.08)_28%,rgba(7,17,31,0.7)_100%)]" />
      <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.24),transparent)]" />

      <div className="relative flex min-h-0 flex-1 flex-col p-5 pb-0">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-bold tracking-[0.04em] text-white/60 mix-blend-plus-lighter">
              <span className="truncate">Bhubaneswar</span>
              <span className="tabular">30°</span>
              <span className="sr-only">
                {healthLoading ? "Server checking" : healthOk ? "Server online" : "Server offline"}
              </span>
            </div>
            <h2 className="mt-1 text-2xl font-medium tracking-tight">{active.label}</h2>
          </div>

          <div
            role="tablist"
            aria-label="Quick access mode"
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
          {mode === "tasks" ? <TasksPanel /> : null}
          {mode === "emails" ? (
            <RailEmpty title="All done!" text="No pending email drafts." />
          ) : null}
          {mode === "meetings" ? (
            <RailEmpty title="All done!" text="You have no meetings scheduled for today." />
          ) : null}
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

function TasksPanel() {
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

      <div
        className={cn(
          "mt-3 flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-1",
          "text-left text-sm text-white/50 transition-colors hover:text-white/90",
        )}
      >
        <input
          type="checkbox"
          aria-label="Mark new todo complete"
          className="mt-0.5 size-4 shrink-0 appearance-none rounded-[4px] border border-white/40 bg-transparent"
        />
        <textarea
          aria-label="Add new to do"
          placeholder="Add new to do"
          rows={1}
          className="min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 text-white outline-none placeholder:text-white/50"
        />
      </div>

      <section className="mt-6">
        <div className="flex items-center gap-1.5">
          <ClipboardCheck size={11} className="text-white/60" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">
            Suggestions
          </p>
        </div>

        <div className="mt-7 border-t border-white/20 pt-5">
          <button
            type="button"
            className={cn(
              "group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left",
              "text-white outline-none transition-colors hover:bg-white/[0.06]",
              "focus-visible:ring-2 focus-visible:ring-white/22",
            )}
          >
            <span className="mt-0.5 text-2xl leading-none text-white/60 transition-colors group-hover:text-white">
              +
            </span>
            <span className="max-w-[230px] text-sm leading-relaxed">
              Review unanswered briefing follow-up
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}

function RailEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid min-h-[280px] place-items-center text-center">
      <div className="flex flex-col items-center">
        <PartyPopper size={40} className="text-white/80 mix-blend-plus-lighter" strokeWidth={1.5} />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-[12px] text-white/60">{text}</p>
      </div>
    </div>
  );
}
