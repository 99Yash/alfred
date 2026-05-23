import type { ReactNode } from "react";
import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";

export function ActionPill({
  status,
  children,
}: {
  status: IntegrationProvider["status"];
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-medium",
        status === "connected" && "bg-vs-green-1 text-vs-green-4",
        status === "available" && "bg-vs-bg-2 text-vs-fg-3",
        status === "soon" && "bg-vs-bg-2 text-vs-fg-2",
      )}
    >
      {children}
    </span>
  );
}
