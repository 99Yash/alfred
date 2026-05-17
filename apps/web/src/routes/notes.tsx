import { IDB_KEY, type SyncedNote } from "@alfred/sync";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUp, FileText, StickyNote } from "lucide-react";
import { useRef, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import {
  EmptyState,
  PageContainer,
  PageHeader,
  SectionHeader,
} from "~/lib/ui";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/notes")({
  component: NotesPage,
});

const listNotes = async (tx: ReadTransaction): Promise<SyncedNote[]> => {
  const entries = await tx.scan({ prefix: IDB_KEY.NOTE({}) }).entries().toArray();
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
      <PageContainer>
        <EmptyState
          icon={<StickyNote size={18} />}
          title="Not signed in"
          description="Sign in to start capturing notes."
          action={
            <a
              href="/login"
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              Sign in
            </a>
          }
        />
      </PageContainer>
    );
  }

  const sorted = [...(notes ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Notes"
        description="Loose captures. Synced across devices via Replicache; not (yet) read by Alfred."
      />

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          createNote();
        }}
        className={cn(
          "relative rounded-xl border bg-card shadow-soft",
          "focus-within:ring-2 focus-within:ring-ring/40 focus-within:border-foreground/40",
          "transition-shadow",
        )}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              createNote();
            }
          }}
          rows={2}
          placeholder="Type a note. Enter to save, Shift+Enter for a newline."
          className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/70 max-h-[40dvh]"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <p className="text-[11px] text-muted-foreground/80">
            {text.length > 0 ? `${text.length} chars` : "Notes are private."}
          </p>
          <button
            type="submit"
            disabled={creating || !text.trim()}
            aria-label="Save note"
            className={cn(
              "inline-flex items-center justify-center size-8 rounded-full transition-colors",
              text.trim() && !creating
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </form>

      <section className="space-y-3">
        <SectionHeader
          title="Recent"
          count={sorted.length}
          description={
            sorted.length === 0
              ? undefined
              : "Newest first. Nothing here is sent to Alfred."
          }
        />

        {notes === undefined ? (
          <p className="text-sm text-muted-foreground px-1">Loading…</p>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<FileText size={18} />}
            title="No notes yet"
            description="Capture something quick — a thought, a task, anything."
          />
        ) : (
          <ul className="space-y-2">
            {sorted.map((note) => (
              <li
                key={note.id}
                className="rounded-lg border bg-card px-4 py-3 text-sm shadow-soft"
              >
                <p className="whitespace-pre-wrap break-words leading-relaxed">
                  {note.text}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground tabular">
                  {formatTimestamp(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
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
