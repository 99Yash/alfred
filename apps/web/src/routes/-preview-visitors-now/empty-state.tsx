import type { ReactNode } from "react";

export function EmptyState({ icon, caption }: { icon: ReactNode; caption: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-vs-fg-2">
      <span className="size-9 rounded-full border border-vs-bg-3 inline-flex items-center justify-center mb-2">
        {icon}
      </span>
      <span className="text-xs">{caption}</span>
    </div>
  );
}
