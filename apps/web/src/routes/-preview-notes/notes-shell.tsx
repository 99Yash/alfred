import type { ReactNode } from "react";

export function NotesShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
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
