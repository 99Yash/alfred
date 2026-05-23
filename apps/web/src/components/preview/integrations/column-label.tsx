import type { ReactNode } from "react";

export function ColumnLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
      {children}
    </span>
  );
}
