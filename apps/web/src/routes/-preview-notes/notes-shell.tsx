import type { ReactNode } from "react";

export function NotesShell({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <header className="space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-app-fg-4">
            Notes
          </h1>
          <p className="text-sm text-app-fg-3">
            Loose captures. Synced across devices; not (yet) read by Alfred.
          </p>
        </header>

        {children}
      </main>
    </div>
  );
}
