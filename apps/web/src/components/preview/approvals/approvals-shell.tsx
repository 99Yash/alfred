/**
 * Page chrome for /preview/approvals — the wide header with title,
 * subtitle, and pending count pill. Keeps the page component clean of
 * layout markup so the route only renders the list.
 */

import type { ReactNode } from "react";
import { VsPill } from "~/components/ui/visitors";

export function ApprovalsShell({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <header className="mb-9 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[36px] leading-[42px] font-medium tracking-tight text-vs-fg-4">
              Approvals
            </h1>
            <p className="mt-2 text-sm text-vs-fg-3">Gated workflow actions waiting for review.</p>
          </div>
          <VsPill tone={count > 0 ? "amber" : undefined}>{count} pending</VsPill>
        </header>

        {children}
      </main>
    </div>
  );
}
