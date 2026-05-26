import { Calendar, Check, Mail } from "lucide-react";
import { cn } from "~/lib/utils";
import type { TodoItem } from "./helpers";
import { RailAddRow } from "./rail-add-row";
import { RailSection } from "./rail-section";
import { SuggestionRow } from "./suggestion-row";

export interface SuggestionInput {
  label: string;
  detail: string;
}

const EMPTY_SUGGESTIONS: ReadonlyArray<SuggestionInput> = [];

export function TodoFeed({
  items,
  suggestions = EMPTY_SUGGESTIONS,
}: {
  items: ReadonlyArray<TodoItem>;
  suggestions?: ReadonlyArray<SuggestionInput>;
}) {
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);

  return (
    <div className="vs-card-in space-y-4 px-1 pt-1">
      {open.length ? (
        <ul className="space-y-0.5">
          {open.map((todo) => (
            <TodoRow key={todo.id} todo={todo} />
          ))}
        </ul>
      ) : (
        <EmptyHint>Nothing on your list yet. Add one below or let Alfred surface tasks from your inbox.</EmptyHint>
      )}

      <RailAddRow placeholder="Add a to-do…" />

      {done.length ? (
        <div className="pt-1">
          <div className="px-2 pb-1.5 text-[10.5px] uppercase tracking-tight font-medium text-white/55">
            Done
          </div>
          <ul className="space-y-0.5">
            {done.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </ul>
        </div>
      ) : null}

      {suggestions.length ? (
        <RailSection title="Suggestions">
          {suggestions.map((s) => (
            <SuggestionRow key={s.label} label={s.label} detail={s.detail} />
          ))}
        </RailSection>
      ) : null}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-3 text-[12px] leading-5 text-white/65">{children}</p>
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
