import type { SyncedFact } from "@alfred/sync";
import { Brain, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { AppCard } from "~/components/ui/v2";
import { ProposedFactCard } from "./proposed-fact-card";
import { SectionHeading } from "./section-heading";
import { useMemoryFacts } from "./use-memory-facts";

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const serialized = JSON.stringify(value);
  return serialized ?? "Unknown value";
}

export function MemoryPage() {
  const { facts, loading, error, retry, confirmFact, rejectFact } = useMemoryFacts();
  const hasCachedFacts = facts.length > 0;

  const { proposed, confirmed } = useMemo(() => {
    const p: SyncedFact[] = [];
    const c: SyncedFact[] = [];
    for (const f of facts) {
      if (f.status === "proposed") p.push(f);
      else c.push(f);
    }
    return { proposed: p, confirmed: c };
  }, [facts]);

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <header className="space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-app-fg-4">
            Memory
          </h1>
          <p className="mx-auto max-w-[44rem] text-sm text-app-fg-3">
            Facts Alfred has learned about you. High-confidence facts auto-confirm; the rest wait
            for your review.
          </p>
        </header>

        {error && !hasCachedFacts ? (
          <AppCard className="mx-auto mt-12 flex w-full max-w-3xl flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <p className="text-sm font-medium text-app-fg-4">Memory could not sync</p>
            <p className="max-w-[28rem] text-xs leading-5 text-app-fg-3">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 rounded-lg bg-app-bg-2 px-3 py-1.5 text-xs font-medium text-app-fg-4 transition-colors outline-none hover:bg-app-bg-3 focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background"
            >
              Retry
            </button>
          </AppCard>
        ) : loading ? (
          <AppCard className="mx-auto mt-12 flex w-full max-w-3xl items-center justify-center px-6 py-12 text-center">
            <p className="text-sm font-medium text-app-fg-4">Loading memory…</p>
          </AppCard>
        ) : (
          <div className="mx-auto mt-12 w-full max-w-3xl space-y-12">
            {error ? (
              <AppCard className="flex items-center justify-between gap-4 px-4 py-3">
                <p className="text-xs text-app-fg-3">
                  Showing cached memory. <span className="text-app-red-4">{error}</span>
                </p>
                <button
                  type="button"
                  onClick={retry}
                  className="shrink-0 text-xs font-medium text-app-fg-4 hover:underline"
                >
                  Retry
                </button>
              </AppCard>
            ) : null}
            <section className="space-y-3">
              <SectionHeading
                title="Proposed"
                count={proposed.length}
                hint="Lower-confidence facts waiting for your review."
              />
              {proposed.length === 0 ? (
                <AppCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <span
                    className="grid size-10 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3"
                    aria-hidden
                  >
                    <Sparkles size={18} />
                  </span>
                  <p className="text-sm font-medium text-app-fg-4">Nothing pending review</p>
                  <p className="max-w-[28rem] text-xs leading-5 text-app-fg-3">
                    When Alfred sees something it isn't sure about, it'll show up here for you to
                    confirm.
                  </p>
                </AppCard>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {proposed.map((fact) => (
                    <li key={fact.id}>
                      <ProposedFactCard
                        fact={fact}
                        onConfirm={() => void confirmFact(fact.id)}
                        onReject={() => void rejectFact(fact.id)}
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
                <AppCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <span
                    className="grid size-10 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3"
                    aria-hidden
                  >
                    <Brain size={18} />
                  </span>
                  <p className="text-sm font-medium text-app-fg-4">No confirmed facts yet</p>
                  <p className="max-w-[28rem] text-xs leading-5 text-app-fg-3">
                    As Alfred works with you, high-confidence facts will land here automatically.
                  </p>
                </AppCard>
              ) : (
                <AppCard padded={false}>
                  <ul className="divide-y divide-app-bg-3">
                    {confirmed.map((fact) => (
                      <li
                        key={fact.id}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-app-bg-a1"
                      >
                        <code className="shrink-0 font-mono text-[12px] text-app-fg-3">
                          {fact.key}
                        </code>
                        <span className="flex-1 truncate font-mono text-[12px] text-app-fg-4">
                          {formatValue(fact.value)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void rejectFact(fact.id)}
                          className="text-[11.5px] text-app-fg-3 transition-colors hover:text-app-red-4"
                        >
                          forget
                        </button>
                      </li>
                    ))}
                  </ul>
                </AppCard>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
