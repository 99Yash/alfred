import { factPrefix, type SyncedFact } from "@alfred/sync";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { useEventStream } from "~/lib/events/use-event-stream";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";

export const Route = createFileRoute("/memory")({
  component: MemoryPage,
});

const listFacts = async (tx: ReadTransaction): Promise<SyncedFact[]> => {
  const entries = await tx.scan({ prefix: factPrefix }).entries().toArray();
  return entries.map(([, v]) => v as unknown as SyncedFact);
};

interface LearnedToast {
  id: number;
  factId: string;
  key: string;
  preview: string;
  confidence: number;
  /** Wall-clock timestamp for ordering + auto-dismiss. */
  receivedAt: number;
}

const TOAST_LIFETIME_MS = 8_000;
const MAX_TOASTS = 5;

function MemoryPage() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const rep = useReplicache();
  const facts = useSubscribe(listFacts);
  const eventFrames = useEventStream(20);

  const [toasts, setToasts] = useState<LearnedToast[]>([]);

  // Map memory.fact_learned events into auto-dismissing toasts. The
  // event stream gives us a running list newest-first; we only react
  // to the head element to avoid re-toasting on reconnect replay.
  useEffect(() => {
    const head = eventFrames[0];
    if (!head || head.kind !== "memory.fact_learned") return;
    const payload = head.payload as {
      factId: string;
      key: string;
      preview: string;
      confidence: number;
    };
    setToasts((prev) => {
      if (prev.some((t) => t.factId === payload.factId)) return prev;
      const next: LearnedToast = {
        id: head.id,
        factId: payload.factId,
        key: payload.key,
        preview: payload.preview,
        confidence: payload.confidence,
        receivedAt: Date.now(),
      };
      return [next, ...prev].slice(0, MAX_TOASTS);
    });
  }, [eventFrames]);

  // Sweep toasts past their lifetime.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => now - t.receivedAt < TOAST_LIFETIME_MS));
    }, 1000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const undoToast = useCallback(
    async (toast: LearnedToast) => {
      if (!rep) return;
      await rep.mutate.factReject({ factId: toast.factId, reason: "auto-confirm undone" });
      dismissToast(toast.id);
    },
    [rep, dismissToast],
  );

  const onConfirm = useCallback(
    async (factId: string) => {
      if (!rep) return;
      await rep.mutate.factConfirm({ factId });
    },
    [rep],
  );

  const onReject = useCallback(
    async (factId: string) => {
      if (!rep) return;
      await rep.mutate.factReject({ factId });
    },
    [rep],
  );

  const onEdit = useCallback(
    async (fact: SyncedFact) => {
      if (!rep) return;
      // Minimal editor — prompts for a JSON value. Strings without quotes
      // are accepted (re-wrapped). Power-user UX, but enough to prove the
      // round-trip; v2 swaps in an inline editor.
      const current =
        typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
      const raw = window.prompt(`Edit value for ${fact.key}`, current);
      if (raw == null) return;
      const trimmed = raw.trim();
      let nextValue: unknown = trimmed;
      try {
        nextValue = JSON.parse(trimmed);
      } catch {
        // not JSON — keep as string
        nextValue = trimmed;
      }
      await rep.mutate.factEdit({
        factId: fact.id,
        newFactId: crypto.randomUUID(),
        newValue: nextValue as never,
      });
    },
    [rep],
  );

  const { proposed, confirmed } = useMemo(() => {
    const p: SyncedFact[] = [];
    const c: SyncedFact[] = [];
    for (const f of facts ?? []) {
      if (f.status === "proposed") p.push(f);
      else if (f.status === "confirmed") c.push(f);
    }
    p.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    c.sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return { proposed: p, confirmed: c };
  }, [facts]);

  const signOut = async () => {
    await authClient.signOut();
    await navigate({ to: "/login" });
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
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Memory</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{session.user.email}</span>
          <a href="/notes" className="underline">
            Notes
          </a>
          <button onClick={signOut} className="underline">
            Sign out
          </button>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Proposed{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({proposed.length})
          </span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Alfred isn't confident enough to add these on its own.
        </p>
        {facts === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : proposed.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing pending review.</p>
        ) : (
          <ul className="space-y-2">
            {proposed.map((fact) => (
              <li key={fact.id} className="rounded-md border px-4 py-3 text-sm space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <code className="font-mono text-xs">{fact.key}</code>
                  <span className="text-xs text-muted-foreground">
                    {(fact.confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>
                <div className="font-mono text-xs whitespace-pre-wrap break-words">
                  {previewValue(fact.value)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {sourceLabel(fact.source)} · {new Date(fact.createdAt).toLocaleString()}
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => onConfirm(fact.id)}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => onReject(fact.id)}
                    className="rounded-md border px-3 py-1 text-xs font-medium"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => onEdit(fact)}
                    className="rounded-md border px-3 py-1 text-xs font-medium"
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Confirmed{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({confirmed.length})
          </span>
        </h2>
        {confirmed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No confirmed facts yet.</p>
        ) : (
          <ul className="space-y-1">
            {confirmed.map((fact) => (
              <li
                key={fact.id}
                className="rounded-md border px-4 py-2 text-sm flex items-center gap-3"
              >
                <code className="font-mono text-xs flex-shrink-0">{fact.key}</code>
                <span className="font-mono text-xs flex-1 truncate">
                  {previewValue(fact.value)}
                </span>
                <button
                  onClick={() => onEdit(fact)}
                  className="text-xs underline text-muted-foreground"
                >
                  edit
                </button>
                <button
                  onClick={() => onReject(fact.id)}
                  className="text-xs underline text-muted-foreground"
                >
                  reject
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Toast stack — anchored bottom-right. */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 max-w-sm z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="rounded-md border bg-background px-4 py-3 text-sm shadow-lg space-y-2"
          >
            <div className="text-xs text-muted-foreground">Alfred learned</div>
            <div>
              <code className="font-mono text-xs">{toast.key}</code>
              <span className="ml-2 font-mono text-xs">{toast.preview}</span>
            </div>
            <div className="flex justify-end gap-2 text-xs">
              <button onClick={() => undoToast(toast)} className="underline">
                Undo
              </button>
              <button onClick={() => dismissToast(toast.id)} className="text-muted-foreground">
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sourceLabel(source: Record<string, unknown> | unknown): string {
  if (typeof source !== "object" || source === null) return "unknown source";
  const s = source as { kind?: unknown; id?: unknown };
  const kind = typeof s.kind === "string" ? s.kind : "unknown";
  const id = typeof s.id === "string" ? s.id : null;
  return id ? `${kind} · ${id}` : kind;
}
