import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Calendar, Check, Mail, X } from "lucide-react";
import { cn } from "~/lib/utils";
import type { RailTodoItem } from "./models";
import { RailAddRow } from "./rail-add-row";
import { SuggestionRow } from "./suggestion-row";

export interface RailTodoSuggestion {
  /** Todo row id (ADR-0050 `suggested` row). Absent on fixture-only previews. */
  id?: string;
  label: string;
  detail: string;
}

const EMPTY_SUGGESTIONS: ReadonlyArray<RailTodoSuggestion> = [];

export function TodoFeed({
  items,
  suggestions = EMPTY_SUGGESTIONS,
  onToggleTodo,
  onClearTodo,
  onCreateTodo,
  onCompleteSuggestion,
  onPromoteSuggestion,
  onDismissSuggestion,
}: {
  items: ReadonlyArray<RailTodoItem>;
  suggestions?: ReadonlyArray<RailTodoSuggestion>;
  /** Check/uncheck a todo. `done` is the row's current state. */
  onToggleTodo?: (id: string, done: boolean) => void;
  /** Clear a completed todo from the rail (`done → cleared`); distinct from reopening. */
  onClearTodo?: (id: string) => void;
  /** Add a user-authored todo. When absent, the add row is a static affordance. */
  onCreateTodo?: (title: string) => void;
  /** Mark a suggestion done directly (`suggested → done`). */
  onCompleteSuggestion?: (id: string) => void;
  /** Accept a suggestion (`suggested → open`). */
  onPromoteSuggestion?: (id: string) => void;
  /** Decline a suggestion (`suggested → dismissed`). */
  onDismissSuggestion?: (id: string) => void;
}) {
  const [openListRef] = useAutoAnimate<HTMLUListElement>();
  const [doneListRef] = useAutoAnimate<HTMLUListElement>();
  const [suggestionsListRef] = useAutoAnimate<HTMLDivElement>();
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);

  return (
    <div className="app-card-in space-y-4 px-1 pt-1">
      <ul ref={openListRef} className="space-y-0.5">
        {open.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            onToggle={onToggleTodo ? () => onToggleTodo(todo.id, false) : undefined}
          />
        ))}
      </ul>

      {open.length ? null : (
        <EmptyHint>
          Nothing on your list yet. Add one below or let Alfred surface tasks from your inbox.
        </EmptyHint>
      )}

      <RailAddRow placeholder="Add a to-do…" onSubmit={onCreateTodo} />

      <div className={done.length ? "pt-1" : undefined}>
        {done.length ? (
          <div className="px-2 pb-1.5 text-[10.5px] font-medium tracking-tight text-white/55 uppercase">
            Done
          </div>
        ) : null}
        <ul ref={doneListRef} className="space-y-0.5">
          {done.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onToggle={onToggleTodo ? () => onToggleTodo(todo.id, true) : undefined}
              onClear={onClearTodo ? () => onClearTodo(todo.id) : undefined}
            />
          ))}
        </ul>
      </div>

      <div className={suggestions.length ? "pt-3" : undefined}>
        {suggestions.length ? (
          <div className="px-1 pb-1.5 text-[10.5px] font-medium tracking-tight text-white/55 uppercase">
            Suggestions
          </div>
        ) : null}
        <div ref={suggestionsListRef} className="space-y-1">
          {suggestions.map((s) => (
            <SuggestionRow
              key={s.id ?? s.label}
              label={s.label}
              detail={s.detail}
              onAccept={s.id && onPromoteSuggestion ? () => onPromoteSuggestion(s.id!) : undefined}
              onComplete={
                s.id && onCompleteSuggestion ? () => onCompleteSuggestion(s.id!) : undefined
              }
              onDismiss={s.id && onDismissSuggestion ? () => onDismissSuggestion(s.id!) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-3 text-[12px] leading-5 text-white/65">{children}</p>;
}

function TodoRow({
  todo,
  onToggle,
  onClear,
}: {
  todo: RailTodoItem;
  onToggle?: () => void;
  /** Clear a completed todo (`done → cleared`). Distinct from unchecking it. */
  onClear?: () => void;
}) {
  return (
    <li
      className={cn(
        "group relative -mx-0.5 flex items-start rounded-xl",
        "transition-colors hover:bg-white/[0.07]",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={todo.done ?? false}
        className={cn(
          "app-press min-w-0 flex-1 rounded-xl p-2 text-left",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-md",
            "border transition-colors",
            todo.done
              ? "border-app-purple-4 bg-app-purple-4 text-white"
              : "border-white/25 bg-transparent group-hover:border-white/50",
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
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear completed to-do: ${todo.title}`}
          className={cn(
            "app-press my-1 mr-1 inline-flex size-6 shrink-0 items-center justify-center self-center rounded-md",
            "text-white/45 transition-[color,background-color,opacity] hover:bg-white/10 hover:text-white",
            "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </li>
  );
}
