import type { ReactNode } from "react";

export function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto scroll-stable">
      <main className="mx-auto w-full max-w-4xl px-4 sm:px-6 py-10 sm:py-16">
        <div className="space-y-8">{children}</div>
      </main>
    </div>
  );
}
