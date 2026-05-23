import type { ComponentType } from "react";
import { VsCard } from "~/components/ui/visitors";

export function PlaceholderCard({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <VsCard padded={false} className="px-5 py-10 flex flex-col items-center gap-2 text-center">
      <span className="grid size-9 place-items-center rounded-full border border-vs-bg-3 text-vs-fg-3" aria-hidden>
        <Icon size={16} />
      </span>
      <p className="text-sm font-medium text-vs-fg-4">{title}</p>
      <p className="text-xs text-vs-fg-3 max-w-xs">{description}</p>
      <p className="text-xs text-vs-fg-2 mt-2">
        This section is wired in milestone 13 alongside the settings backend.
      </p>
    </VsCard>
  );
}
