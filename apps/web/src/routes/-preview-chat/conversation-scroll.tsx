import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function ConversationScroll({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 pt-10 pb-8">{children}</div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none sticky bottom-0 left-0 right-0 h-10",
          "bg-gradient-to-t from-app-background to-transparent",
        )}
      />
    </div>
  );
}
