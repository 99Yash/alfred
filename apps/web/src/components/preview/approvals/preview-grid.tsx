import type { ReactNode } from "react";

export function PreviewGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-2 rounded-xl bg-vs-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
      {children}
    </div>
  );
}
