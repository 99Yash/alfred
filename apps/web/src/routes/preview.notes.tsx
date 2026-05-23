import { createFileRoute } from "@tanstack/react-router";
import { ArrowUp, FileText, Mic } from "lucide-react";
import { useRef, useState } from "react";
import { VsCard, VsTextarea } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /notes.
 *
 * Composer at the top + reverse-chronological list. Replicache wiring is
 * intentionally stubbed — notes live in component state so the page can
 * be reviewed in isolation. The Save button + Enter-to-save both push
 * into the local list.
 */
export const Route = createFileRoute("/preview/notes")({
  component: PreviewNotesPage,
});

interface LocalNote {
  id: string;
  text: string;
  createdAt: string;
}

const SEED_NOTES: LocalNote[] = [
  {
    id: "seed-1",
    text: "Look up Sycamore's last three sends before tomorrow's call.",
    createdAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  },
  {
    id: "seed-2",
    text: "Decision: park the Linear renewal until end of quarter; cheaper to keep month-to-month for now.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
  },
  {
    id: "seed-3",
    text: "Personal — schedule the FATCA forms by May 26; ping the bank if no acknowledgement by Friday.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
];

function PreviewNotesPage() {
  const [notes, setNotes] = useState<LocalNote[]>(SEED_NOTES);
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const createNote = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const next: LocalNote = {
      id: `local-${Date.now()}`,
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    setNotes((prev) => [next, ...prev]);
    setText("");
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const hasContent = text.trim().length > 0;

  return (
    <NotesShell>
      <div className="mx-auto w-full max-w-[688px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createNote();
          }}
          className={cn(
            "mt-10 w-full rounded-2xl bg-vs-bg-1 p-1",
            "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.06)]",
            "focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.06),0_0_0_4px_var(--vs-purple-2)]",
            "transition-shadow",
          )}
        >
          <VsTextarea
            ref={textareaRef}
            variant="inline"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                createNote();
              }
            }}
            rows={2}
            placeholder="Type a note. Enter to save, Shift+Enter for a newline."
            className="min-h-[64px] max-h-[40dvh] px-3 pt-3 pb-2 text-sm leading-6"
          />

          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <p className="pl-2 text-[11.5px] text-vs-fg-2">
              {hasContent ? `${text.length} chars` : "Notes are private."}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Voice input"
                disabled
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-full",
                  "text-vs-fg-2 hover:text-vs-fg-3 transition-colors",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                <Mic size={15} />
              </button>
              <button
                type="submit"
                disabled={!hasContent}
                aria-label="Save note"
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-full",
                  "text-[var(--vs-accent-fg)] bg-[image:var(--vs-cta-bg)]",
                  "shadow-[var(--vs-button-primary-shadow)]",
                  "transition-[opacity,filter,transform] active:scale-[0.96]",
                  hasContent
                    ? "hover:brightness-[1.06] active:brightness-[0.96]"
                    : "opacity-50 cursor-not-allowed",
                )}
              >
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </form>

        <section className="mt-12 space-y-3">
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[15px] font-medium text-vs-fg-4">Recent</h2>
            <span className="text-[12.5px] text-vs-fg-2 tabular-nums">{notes.length}</span>
          </div>

          {notes.length === 0 ? (
            <VsCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <span
                className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
                aria-hidden
              >
                <FileText size={18} />
              </span>
              <p className="text-sm font-medium text-vs-fg-4">No notes yet</p>
              <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
                Capture something quick: a thought, a task, anything. Newest first; nothing here is
                sent to Alfred.
              </p>
            </VsCard>
          ) : (
            <ul className="flex flex-col gap-2">
              {notes.map((note) => (
                <li key={note.id}>
                  <VsCard className="px-4 py-3">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-vs-fg-4">
                      {note.text}
                    </p>
                    <p className="mt-2 text-[11.5px] text-vs-fg-2 tabular-nums">
                      {formatTimestamp(note.createdAt)}
                    </p>
                  </VsCard>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </NotesShell>
  );
}

function NotesShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <header className="space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-vs-fg-4">
            Notes
          </h1>
          <p className="text-sm text-vs-fg-3">
            Loose captures. Synced across devices; not (yet) read by Alfred.
          </p>
        </header>

        {children}
      </main>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `Today, ${d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
