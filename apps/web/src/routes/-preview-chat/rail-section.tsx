import type { ReactNode } from "react";

export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pt-3">
      <div className="px-1 pb-1.5 text-[10.5px] font-medium tracking-tight text-white/55 uppercase">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
