import { IDB_KEY, type SyncedFact } from "@alfred/sync";
import { createFileRoute } from "@tanstack/react-router";
import { Brain, Check, Pencil, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { StatusDot, type StatusTone } from "~/components/ui/status-dot";
import { authClient } from "~/lib/auth-client";
import { useEventStream } from "~/lib/events/use-event-stream";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/memory")({
  component: MemoryPage,
});

const listFacts = async (tx: ReadTransaction): Promise<SyncedFact[]> => {
  const entries = await tx
    .scan({ prefix: IDB_KEY.FACT({}) })
    .entries()
    .toArray();
  return entries.map(([, v]) => v as unknown as SyncedFact);
};

interface LearnedToast {
  id: number;
  factId: string;
  key: string;
  preview: string;
  confidence: number;
  receivedAt: number;
}

const TOAST_LIFETIME_MS = 8_000;
const MAX_TOASTS = 5;

function MemoryPage() {
  const { data: session } = authClient.useSession();
  const rep = useReplicache();
  const facts = useSubscribe(listFacts);
  const eventFrames = useEventStream(20);

  const [toasts, setToasts] = useState<LearnedToast[]>([]);

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
      const current = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
      const raw = window.prompt(`Edit value for ${fact.key}`, current);
      if (raw == null) return;
      const trimmed = raw.trim();
      let nextValue: unknown = trimmed;
      try {
        nextValue = JSON.parse(trimmed);
      } catch {
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

  if (!session?.user) {
    return (
      <MemoryShell>
        <div className="mt-12">
          <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span
              className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
              aria-hidden
            >
              <Brain size={18} />
            </span>
            <p className="text-sm font-medium text-gray-950">Not signed in</p>
            <p className="text-[12.5px] text-gray-800">Sign in to view Alfred's memory.</p>
            <a
              href="/login"
              className="mt-2 text-[12.5px] text-gray-900 underline underline-offset-4 hover:text-gray-1000"
            >
              Sign in
            </a>
          </Card>
        </div>
      </MemoryShell>
    );
  }

  return (
    <>
      <MemoryShell>
        <div className="mx-auto mt-12 w-full max-w-3xl space-y-12">
          <section className="space-y-3">
            <SectionHeading
              title="Proposed"
              count={proposed.length}
              hint="Alfred isn't confident enough to add these on its own."
            />
            {facts === undefined ? (
              <p className="text-sm text-gray-800 px-1">Loading…</p>
            ) : proposed.length === 0 ? (
              <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <span
                  className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
                  aria-hidden
                >
                  <Sparkles size={18} />
                </span>
                <p className="text-sm font-medium text-gray-950">Nothing pending review</p>
                <p className="max-w-[28rem] text-[12.5px] text-gray-800">
                  When Alfred sees something it isn't sure about, it'll show up here for you to
                  confirm.
                </p>
              </Card>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {proposed.map((fact) => (
                  <li key={fact.id}>
                    <ProposedFactCard
                      fact={fact}
                      onConfirm={() => onConfirm(fact.id)}
                      onEdit={() => onEdit(fact)}
                      onReject={() => onReject(fact.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeading
              title="Confirmed"
              count={confirmed.length}
              hint={
                confirmed.length === 0
                  ? undefined
                  : "Acts as background context on every Alfred run."
              }
            />
            {confirmed.length === 0 ? (
              <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <span
                  className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
                  aria-hidden
                >
                  <Brain size={18} />
                </span>
                <p className="text-sm font-medium text-gray-950">No confirmed facts yet</p>
                <p className="max-w-[28rem] text-[12.5px] text-gray-800">
                  As Alfred works with you, high-confidence facts will land here automatically.
                </p>
              </Card>
            ) : (
              <Card className="overflow-hidden p-0">
                <ul className="divide-y divide-white/[0.04]">
                  {confirmed.map((fact) => (
                    <li
                      key={fact.id}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-950 transition-colors hover:bg-white/[0.02]"
                    >
                      <code className="font-mono text-[12px] shrink-0 text-gray-800">
                        {fact.key}
                      </code>
                      <span className="font-mono text-[12px] flex-1 truncate text-gray-950">
                        {previewValue(fact.value)}
                      </span>
                      <button
                        onClick={() => onEdit(fact)}
                        className="text-[11.5px] text-gray-800 transition-colors hover:text-gray-1000"
                      >
                        edit
                      </button>
                      <button
                        onClick={() => onReject(fact.id)}
                        className="text-[11.5px] text-gray-800 transition-colors hover:text-red-400"
                      >
                        forget
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </div>
      </MemoryShell>

      {/* Toast stack — anchored bottom-right. */}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn("frost-popover animate-toast-in rounded-2xl px-4 py-3 text-sm")}
          >
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-gray-800">
              <Sparkles size={11} /> Alfred learned
            </div>
            <div className="space-y-1">
              <code className="font-mono text-[11px] text-gray-800">{toast.key}</code>
              <p className="break-words font-mono text-[13px] text-gray-1000">{toast.preview}</p>
            </div>
            <div className="flex justify-end gap-2 pt-2 text-[11.5px]">
              <button
                onClick={() => undoToast(toast)}
                className="text-gray-900 underline underline-offset-2 transition-colors hover:text-gray-1000"
              >
                Undo
              </button>
              <button
                onClick={() => dismissToast(toast.id)}
                className="text-gray-800 transition-colors hover:text-gray-1000"
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout shell                                                               */
/* -------------------------------------------------------------------------- */

function MemoryShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Memory
        </h1>
        <p className="mx-auto max-w-[44rem] text-sm text-gray-800">
          Facts Alfred has learned about you. High-confidence facts auto-confirm; the rest wait for
          your review.
        </p>
      </header>

      {children}
    </div>
  );
}

function SectionHeading({ title, count, hint }: { title: string; count?: number; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-medium text-gray-1000">{title}</h2>
        {typeof count === "number" ? (
          <span className="text-[12.5px] text-gray-800 tabular">{count}</span>
        ) : null}
      </div>
      {hint ? <p className="text-[12.5px] text-gray-800">{hint}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Proposed fact card                                                         */
/* -------------------------------------------------------------------------- */

function ProposedFactCard({
  fact,
  onConfirm,
  onEdit,
  onReject,
}: {
  fact: SyncedFact;
  onConfirm: () => void;
  onEdit: () => void;
  onReject: () => void;
}) {
  return (
    <Card className="space-y-2.5 px-4 py-3 text-gray-950">
      <div className="flex items-baseline justify-between gap-3">
        <code className="font-mono text-[12px] text-gray-1000 break-all">{fact.key}</code>
        <ConfidenceChip confidence={fact.confidence} />
      </div>
      <div className="rounded-md bg-white/[0.03] px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-gray-1000">
        {previewValue(fact.value)}
      </div>
      <div className="text-[11px] text-gray-800 tabular">
        {sourceLabel(fact.source)} · {new Date(fact.createdAt).toLocaleString()}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <Button variant="primary" size="sm" onClick={onConfirm} leading={<Check size={12} />}>
          Confirm
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} leading={<Pencil size={12} />}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onReject} leading={<X size={12} />}>
          Reject
        </Button>
      </div>
    </Card>
  );
}

function ConfidenceChip({ confidence }: { confidence: number }) {
  const tone: StatusTone = confidence >= 0.75 ? "emerald" : confidence >= 0.5 ? "amber" : "red";
  const pct = (confidence * 100).toFixed(0);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-gray-1000 tabular">
      <StatusDot tone={tone} size="sm" />
      {pct}%
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

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
