import { VsCard } from "~/components/ui/visitors";

export function NotFound() {
  return (
    <VsCard className="mt-8 flex flex-col items-center gap-2 px-6 py-12 text-center vs-card-in">
      <p className="text-sm font-medium text-vs-fg-4">Integration not found</p>
      <p className="max-w-md text-[12.5px] text-vs-fg-3">
        This provider is not available in the local preview.
      </p>
    </VsCard>
  );
}
