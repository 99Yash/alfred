import { createFileRoute } from "@tanstack/react-router";
import { Brain, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { VsCard } from "~/components/ui/visitors";
import type { LocalFact } from "./-preview-memory/helpers";
import { ProposedFactCard } from "./-preview-memory/proposed-fact-card";
import { SectionHeading } from "./-preview-memory/section-heading";

/**
 * Visitors-now-grammar port of /memory.
 *
 * Two sections (Proposed / Confirmed) over fixture facts. Replicache
 * subscribe + factConfirm/Reject/Edit are stubbed — actions mutate
 * local state so the page can be reviewed in isolation. The toast
 * stack from the dimension version is dropped (no event bridge to
 * subscribe to in preview).
 */
export const Route = createFileRoute("/preview/memory")({
  component: PreviewMemoryPage,
});

const SEED_FACTS: LocalFact[] = [
  {
    id: "p1",
    key: "user.timezone",
    value: "Asia/Kolkata",
    status: "proposed",
    confidence: 0.62,
    source: "gmail · headers · last 7 days",
    createdAt: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
  },
  {
    id: "p2",
    key: "preferences.morning_briefing_time",
    value: "08:00",
    status: "proposed",
    confidence: 0.48,
    source: "chat · 2026-05-22",
    createdAt: new Date(Date.now() - 1000 * 60 * 95).toISOString(),
  },
  {
    id: "c1",
    key: "user.full_name",
    value: "Yash Gourav Kar",
    status: "confirmed",
    confidence: 1,
    source: "google · profile",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
  },
  {
    id: "c2",
    key: "company.name",
    value: "Alfred Labs",
    status: "confirmed",
    confidence: 0.92,
    source: "research · sonar deep",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
  },
  {
    id: "c3",
    key: "company.stage",
    value: "Pre-seed, single founder",
    status: "confirmed",
    confidence: 0.88,
    source: "research · sonar deep",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
  },
  {
    id: "c4",
    key: "writing.style",
    value: "Concise; bullet-friendly; rarely uses exclamation marks.",
    status: "confirmed",
    confidence: 0.81,
    source: "gmail · drafts · last 30 days",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
  },
  {
    id: "c5",
    key: "calendar.work_hours",
    value: "10:00–19:00 IST",
    status: "confirmed",
    confidence: 0.79,
    source: "calendar · last 14 days",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
  },
];

function PreviewMemoryPage() {
  const [facts, setFacts] = useState<LocalFact[]>(SEED_FACTS);

  const { proposed, confirmed } = useMemo(() => {
    const p: LocalFact[] = [];
    const c: LocalFact[] = [];
    for (const f of facts) {
      if (f.status === "proposed") p.push(f);
      else c.push(f);
    }
    return { proposed: p, confirmed: c };
  }, [facts]);

  const confirmFact = (id: string) =>
    setFacts((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status: "confirmed", confidence: 1 } : f)),
    );

  const rejectFact = (id: string) => setFacts((prev) => prev.filter((f) => f.id !== id));

  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <header className="space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-vs-fg-4">
            Memory
          </h1>
          <p className="mx-auto max-w-[44rem] text-sm text-vs-fg-3">
            Facts Alfred has learned about you. High-confidence facts auto-confirm; the rest wait
            for your review.
          </p>
        </header>

        <div className="mx-auto mt-12 w-full max-w-3xl space-y-12">
          <section className="space-y-3">
            <SectionHeading
              title="Proposed"
              count={proposed.length}
              hint="Alfred isn't confident enough to add these on its own."
            />
            {proposed.length === 0 ? (
              <VsCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <span
                  className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
                  aria-hidden
                >
                  <Sparkles size={18} />
                </span>
                <p className="text-sm font-medium text-vs-fg-4">Nothing pending review</p>
                <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
                  When Alfred sees something it isn't sure about, it'll show up here for you to
                  confirm.
                </p>
              </VsCard>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {proposed.map((fact) => (
                  <li key={fact.id}>
                    <ProposedFactCard
                      fact={fact}
                      onConfirm={() => confirmFact(fact.id)}
                      onReject={() => rejectFact(fact.id)}
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
                confirmed.length === 0 ? undefined : "Acts as background context on every Alfred run."
              }
            />
            {confirmed.length === 0 ? (
              <VsCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <span
                  className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
                  aria-hidden
                >
                  <Brain size={18} />
                </span>
                <p className="text-sm font-medium text-vs-fg-4">No confirmed facts yet</p>
                <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
                  As Alfred works with you, high-confidence facts will land here automatically.
                </p>
              </VsCard>
            ) : (
              <VsCard padded={false}>
                <ul className="divide-y divide-vs-bg-3">
                  {confirmed.map((fact) => (
                    <li
                      key={fact.id}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-vs-bg-a1"
                    >
                      <code className="font-mono text-[12px] shrink-0 text-vs-fg-3">
                        {fact.key}
                      </code>
                      <span className="font-mono text-[12px] flex-1 truncate text-vs-fg-4">
                        {fact.value}
                      </span>
                      <button
                        type="button"
                        className="text-[11.5px] text-vs-fg-3 transition-colors hover:text-vs-fg-4"
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        onClick={() => rejectFact(fact.id)}
                        className="text-[11.5px] text-vs-fg-3 transition-colors hover:text-vs-red-4"
                      >
                        forget
                      </button>
                    </li>
                  ))}
                </ul>
              </VsCard>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
