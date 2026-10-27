import { AppButton, AppCard } from "~/components/ui/v2";

/**
 * A sync error above rows that are still on screen. `useReplicacheSubscription` keeps cached rows
 * through a failed pull, so a surface with rows shows this line, not a full error panel.
 */
export function CachedSyncNotice({
  subject,
  error,
  retry,
}: {
  /** Plural noun, as in "Showing cached approvals." */
  subject: string;
  error: string;
  retry: () => void;
}) {
  return (
    <AppCard className="flex items-center justify-between gap-4 px-4 py-3">
      <p className="text-xs text-app-fg-3">
        Showing cached {subject}. <span className="text-app-red-4">{error}</span>
      </p>
      <AppButton size="sm" onClick={retry}>
        Retry
      </AppButton>
    </AppCard>
  );
}
