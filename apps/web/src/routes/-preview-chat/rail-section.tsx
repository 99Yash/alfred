import type { ReactNode } from "react";

export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pt-3">
      <div className="px-1 pb-1.5 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
