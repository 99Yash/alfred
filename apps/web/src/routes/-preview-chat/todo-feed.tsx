import { Calendar, Check, Mail } from "lucide-react";
import { cn } from "~/lib/utils";
import type { TodoItem } from "./helpers";
import { RailAddRow } from "./rail-add-row";
import { RailSection } from "./rail-section";
import { SuggestionRow } from "./suggestion-row";

export interface SuggestionInput {
  /** Todo row id (ADR-0050 `suggested` row). Absent on fixture-only previews. */
  id?: string;
  label: string;
  detail: string;
}

const EMPTY_SUGGESTIONS: ReadonlyArray<SuggestionInput> = [];

export function TodoFeed({
  items,
  suggestions = EMPTY_SUGGESTIONS,
  onToggleTodo,
  onCreateTodo,
  onPromoteSuggestion,
}: {
  items: ReadonlyArray<TodoItem>;
  suggestions?: ReadonlyArray<SuggestionInput>;
  /** Check/uncheck a todo. `done` is the row's current state. */
  onToggleTodo?: (id: string, done: boolean) => void;
  /** Add a user-authored todo. When absent, the add row is a static affordance. */
  onCreateTodo?: (title: string) => void;
  /** Accept a suggestion (`suggested → open`). */
  onPromoteSuggestion?: (id: string) => void;
}) {
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);

  return (
    <div className="app-card-in space-y-4 px-1 pt-1">
      {open.length ? (
        <ul className="space-y-0.5">
          {open.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onToggle={onToggleTodo ? () => onToggleTodo(todo.id, false) : undefined}
            />
          ))}
        </ul>
      ) : (
        <EmptyHint>
          Nothing on your list yet. Add one below or let Alfred surface tasks from your inbox.
        </EmptyHint>
      )}

      <RailAddRow placeholder="Add a to-do…" onSubmit={onCreateTodo} />

      {done.length ? (
        <div className="pt-1">
          <div className="px-2 pb-1.5 text-[10.5px] uppercase tracking-tight font-medium text-white/55">
            Done
          </div>
          <ul className="space-y-0.5">
            {done.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                onToggle={onToggleTodo ? () => onToggleTodo(todo.id, true) : undefined}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {suggestions.length ? (
        <RailSection title="Suggestions">
          {suggestions.map((s) => (
            <SuggestionRow
              key={s.id ?? s.label}
              label={s.label}
              detail={s.detail}
              onAccept={s.id && onPromoteSuggestion ? () => onPromoteSuggestion(s.id!) : undefined}
            />
          ))}
        </RailSection>
      ) : null}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-3 text-[12px] leading-5 text-white/65">{children}</p>;
}

function TodoRow({ todo, onToggle }: { todo: TodoItem; onToggle?: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={todo.done ?? false}
        className={cn(
          "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
          "hover:bg-white/[0.07] transition-colors app-press",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 rounded-md inline-flex items-center justify-center",
            "border transition-colors",
            todo.done
              ? "bg-app-purple-4 border-app-purple-4 text-white"
              : "border-white/25 group-hover:border-white/50 bg-transparent",
          )}
        >
          {todo.done ? <Check size={10} strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-[13px] leading-5 font-medium",
              todo.done ? "text-white/55 line-through" : "text-white",
            )}
          >
            {todo.title}
          </span>
          {todo.due || todo.source ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/55">
              {todo.source === "email" ? (
                <Mail size={10} className="text-app-sky-4" aria-hidden />
              ) : null}
              {todo.source === "meeting" ? (
                <Calendar size={10} className="text-app-amber-4" aria-hidden />
              ) : null}
              {todo.due ? <span>{todo.due}</span> : null}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
