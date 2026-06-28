import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function ConversationScroll({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-stable relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 pt-10 pb-8">{children}</div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none sticky right-0 bottom-0 left-0 h-10",
          "bg-linear-to-t from-app-background to-transparent",
        )}
      />
    </div>
  );
}
