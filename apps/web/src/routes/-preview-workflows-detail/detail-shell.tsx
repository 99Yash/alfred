import type { ReactNode } from "react";

export function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-16">
        <div className="space-y-8">{children}</div>
      </main>
    </div>
  );
}
