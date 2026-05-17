import { IDB_KEY, type SyncedFact } from "@alfred/sync";
import { createFileRoute } from "@tanstack/react-router";
import { Brain, Check, Pencil, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { useEventStream } from "~/lib/events/use-event-stream";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import {
  Button,
  EmptyState,
  PageContainer,
  PageHeader,
  Pill,
  SectionHeader,
} from "~/lib/ui";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/memory")({
  component: MemoryPage,
});

const listFacts = async (tx: ReadTransaction): Promise<SyncedFact[]> => {
  const entries = await tx.scan({ prefix: IDB_KEY.FACT({}) }).entries().toArray();
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
      const current =
        typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
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
      <PageContainer>
        <EmptyState
          icon={<Brain size={18} />}
          title="Not signed in"
          description="Sign in to view Alfred's memory."
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

  return (
    <>
      <PageContainer>
        <PageHeader
          eyebrow="Workspace"
          title="Memory"
          description="Facts Alfred has learned about you. High-confidence facts auto-confirm; the rest wait for your review."
        />

        <section className="space-y-3">
          <SectionHeader
            title="Proposed"
            count={proposed.length}
            description="Alfred isn't confident enough to add these on its own."
          />
          {facts === undefined ? (
            <p className="text-sm text-muted-foreground px-1">Loading…</p>
          ) : proposed.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={18} />}
              title="Nothing pending review"
              description="When Alfred sees something it isn't sure about, it'll show up here."
            />
          ) : (
            <ul className="space-y-2">
              {proposed.map((fact) => (
                <li
                  key={fact.id}
                  className="rounded-lg border bg-card px-4 py-3 text-sm shadow-soft space-y-2.5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <code className="font-mono text-[12px] text-foreground/90 break-all">
                      {fact.key}
                    </code>
                    <Pill tone={confidenceTone(fact.confidence)}>
                      {(fact.confidence * 100).toFixed(0)}%
                    </Pill>
                  </div>
                  <div className="rounded-md bg-muted/40 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words">
                    {previewValue(fact.value)}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular">
                    {sourceLabel(fact.source)} ·{" "}
                    {new Date(fact.createdAt).toLocaleString()}
                  </div>
                  <div className="flex gap-1.5 pt-0.5">
                    <Button size="sm" onClick={() => onConfirm(fact.id)}>
                      <Check size={12} /> Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onEdit(fact)}
                    >
                      <Pencil size={12} /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onReject(fact.id)}
                    >
                      <X size={12} /> Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <SectionHeader
            title="Confirmed"
            count={confirmed.length}
            description={
              confirmed.length === 0
                ? undefined
                : "Acts as background context on every Alfred run."
            }
          />
          {confirmed.length === 0 ? (
            <EmptyState
              icon={<Brain size={18} />}
              title="No confirmed facts yet"
              description="As Alfred works with you, high-confidence facts will land here automatically."
            />
          ) : (
            <ul className="divide-y rounded-lg border bg-card shadow-soft overflow-hidden">
              {confirmed.map((fact) => (
                <li
                  key={fact.id}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/30 transition-colors"
                >
                  <code className="font-mono text-[12px] shrink-0 text-muted-foreground">
                    {fact.key}
                  </code>
                  <span className="font-mono text-[12px] flex-1 truncate">
                    {previewValue(fact.value)}
                  </span>
                  <button
                    onClick={() => onEdit(fact)}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => onReject(fact.id)}
                    className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageContainer>

      {/* Toast stack — anchored bottom-right, above the right rail if present. */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 max-w-sm z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "rounded-lg border bg-popover px-4 py-3 text-sm shadow-pop",
              "animate-toast-in",
            )}
          >
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
              <Sparkles size={11} /> Alfred learned
            </div>
            <div className="space-y-1">
              <code className="font-mono text-[11px] text-muted-foreground">
                {toast.key}
              </code>
              <p className="text-[13px] font-mono break-words">{toast.preview}</p>
            </div>
            <div className="flex justify-end gap-2 text-[11px] pt-2">
              <button
                onClick={() => undoToast(toast)}
                className="underline hover:text-foreground"
              >
                Undo
              </button>
              <button
                onClick={() => dismissToast(toast.id)}
                className="text-muted-foreground hover:text-foreground"
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

function confidenceTone(c: number): "positive" | "warning" | "negative" {
  if (c >= 0.75) return "positive";
  if (c >= 0.5) return "warning";
  return "negative";
}
