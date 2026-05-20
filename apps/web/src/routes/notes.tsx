import { IDB_KEY, type SyncedNote } from "@alfred/sync";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUp, FileText, Mic, StickyNote } from "lucide-react";
import { useRef, useState } from "react";
import type { ReadTransaction } from "replicache";
import { Card } from "~/components/ui/card";
import { IconButton } from "~/components/ui/icon-button";
import { Textarea } from "~/components/ui/textarea";
import { authClient } from "~/lib/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/notes")({
  component: NotesPage,
});

const listNotes = async (tx: ReadTransaction): Promise<SyncedNote[]> => {
  const entries = await tx
    .scan({ prefix: IDB_KEY.NOTE({}) })
    .entries()
    .toArray();
  return entries.map(([, v]) => v as unknown as SyncedNote);
};

function NotesPage() {
  const { data: session } = authClient.useSession();
  const rep = useReplicache();
  const notes = useSubscribe(listNotes);
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const createNote = async () => {
    if (!rep || !text.trim() || !session?.user) return;
    setCreating(true);
    try {
      await rep.mutate.noteCreate({
        id: crypto.randomUUID(),
        userId: session.user.id,
        text: text.trim(),
        createdAt: new Date().toISOString(),
      });
      setText("");
      queueMicrotask(() => textareaRef.current?.focus());
    } finally {
      setCreating(false);
    }
  };

  if (!session?.user) {
    return (
      <NotesShell>
        <div className="mt-12">
          <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span
              className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
              aria-hidden
            >
              <StickyNote size={18} />
            </span>
            <p className="text-sm font-medium text-gray-950">Not signed in</p>
            <p className="text-[12.5px] text-gray-800">Sign in to start capturing notes.</p>
            <a
              href="/login"
              className="mt-2 text-[12.5px] text-gray-900 underline underline-offset-4 hover:text-gray-1000"
            >
              Sign in
            </a>
          </Card>
        </div>
      </NotesShell>
    );
  }

  const sorted = [...(notes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const hasContent = text.trim().length > 0;

  return (
    <NotesShell>
      <div className="mx-auto w-full max-w-[688px]">
        {/* Composer — same chrome grammar as the home composer but trimmed:
         * no mention/approval/model row, just text + mic (disabled) + send. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createNote();
          }}
          className={cn(
            "mt-10 w-full",
            "relative overflow-visible rounded-2xl bg-[#080808]/95 p-1 shadow-pop",
            "ring-1 ring-white/10 backdrop-blur-sm",
            "focus-within:ring-2 focus-within:ring-purple-500/40",
            "transition-[box-shadow,background-color]",
          )}
        >
          <Textarea
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
            className="composer-editor min-h-[64px] max-h-[40dvh] px-3 pt-3 pb-2 text-sm leading-6"
          />

          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <p className="pl-2 text-[11.5px] text-gray-800">
              {hasContent ? `${text.length} chars` : "Notes are private."}
            </p>
            <div className="flex items-center gap-1">
              <IconButton label="Voice input" disabled className="rounded-full">
                <Mic size={15} />
              </IconButton>
              <button
                type="submit"
                disabled={creating || !hasContent}
                aria-label="Save note"
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-full",
                  "transition-[opacity,filter,transform] active:scale-[0.96]",
                  "text-black backdrop-blur-sm",
                  "bg-[linear-gradient(180deg,#a5a5a5_46%,#e3e3e3_100%)]",
                  "shadow-[0_0_0_0.5px_rgba(0,0,0,0.4),0_18px_11px_rgba(0,0,0,0.01),0_8px_8px_rgba(0,0,0,0.01),0_2px_4px_rgba(0,0,0,0.02)]",
                  hasContent && !creating
                    ? "hover:brightness-110 active:brightness-105"
                    : "opacity-50 cursor-not-allowed",
                )}
              >
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </form>

        <section className="mt-12 space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-medium text-gray-1000">Recent</h2>
            <span className="text-[12.5px] text-gray-800 tabular">{sorted.length}</span>
          </div>

          {notes === undefined ? (
            <p className="text-sm text-gray-800 px-1">Loading…</p>
          ) : sorted.length === 0 ? (
            <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <span
                className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
                aria-hidden
              >
                <FileText size={18} />
              </span>
              <p className="text-sm font-medium text-gray-950">No notes yet</p>
              <p className="max-w-[28rem] text-[12.5px] text-gray-800">
                Capture something quick — a thought, a task, anything. Newest first; nothing here is
                sent to Alfred.
              </p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-1">
              {sorted.map((note) => (
                <li key={note.id}>
                  <Card className="px-4 py-3 text-gray-950">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {note.text}
                    </p>
                    <p className="mt-2 text-[11.5px] text-gray-800 tabular">
                      {formatTimestamp(note.createdAt)}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </NotesShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout shell                                                               */
/* -------------------------------------------------------------------------- */

function NotesShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Notes
        </h1>
        <p className="text-sm text-gray-800">
          Loose captures. Synced across devices — not (yet) read by Alfred.
        </p>
      </header>

      {children}
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
