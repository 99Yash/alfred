import { Calendar, Check, Mail } from "lucide-react";
import { cn } from "~/lib/utils";
import { TODOS, type TodoItem } from "./helpers";
import { RailAddRow } from "./rail-add-row";
import { RailSection } from "./rail-section";
import { SuggestionRow } from "./suggestion-row";

export function TodoFeed() {
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
