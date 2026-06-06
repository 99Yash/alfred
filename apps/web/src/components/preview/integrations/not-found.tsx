import { AppCard } from "~/components/ui/v2";

export function NotFound() {
  return (
    <AppCard className="mt-8 flex flex-col items-center gap-2 px-6 py-12 text-center app-card-in">
      <p className="text-sm font-medium text-app-fg-4">Integration not found</p>
      <p className="max-w-md text-[12.5px] text-app-fg-3">
        This provider is not available in the local preview.
      </p>
    </AppCard>
  );
}
