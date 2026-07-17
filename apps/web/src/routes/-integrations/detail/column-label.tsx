import type { ReactNode } from "react";

export function ColumnLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10.5px] font-medium tracking-tight text-app-fg-2 uppercase">
      {children}
    </span>
  );
}
