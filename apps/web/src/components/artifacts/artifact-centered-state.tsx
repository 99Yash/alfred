import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** The empty / loading / error placeholder every artifact body falls back to. */
export function ArtifactCenteredState({
  icon,
  text,
  className,
}: {
  icon: ReactNode;
  text: string;
  className?: string | undefined;
}) {
  return (
    <div className={cn("grid flex-1 place-items-center px-8 text-center text-app-fg-4", className)}>
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-12 place-items-center rounded-2xl bg-app-bg-a2 text-app-fg-3">
          {icon}
        </span>
        <p className="text-sm">{text}</p>
      </div>
    </div>
  );
}
