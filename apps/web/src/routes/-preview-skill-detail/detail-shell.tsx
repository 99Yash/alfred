import type { ReactNode } from "react";

export function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="space-y-6">{children}</div>
      </main>
    </div>
  );
}
