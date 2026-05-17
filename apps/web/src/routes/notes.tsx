import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "~/lib/auth-client";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import { IDB_KEY } from "@alfred/sync";
import type { SyncedNote } from "@alfred/sync";
import type { ReadTransaction } from "replicache";

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
    } finally {
      setCreating(false);
    }
  };

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">Not signed in.</p>
          <a href="/login" className="underline text-sm">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">Notes</h1>

      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createNote()}
          placeholder="New note…"
          className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          onClick={createNote}
          disabled={creating || !text.trim() || !rep}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {creating ? "Saving…" : "Add"}
        </button>
      </div>

      {notes === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet. Create one above.</p>
      ) : (
        <ul className="space-y-2">
          {[...notes]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((note) => (
              <li key={note.id} className="rounded-md border px-4 py-3 text-sm">
                <p>{note.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(note.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
