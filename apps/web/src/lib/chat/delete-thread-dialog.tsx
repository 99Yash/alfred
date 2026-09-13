import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppButton } from "~/components/ui/v2";

/**
 * Delete confirmation for one chat thread, used by BOTH menus that offer the
 * action — the sidebar row and the chat header.
 *
 * `target` is `{ title } | null` rather than a `ThreadEntry`, because the title
 * is the only field the copy reads and the header knows nothing else about the
 * thread it is showing. Widening it here retired a near-identical private twin
 * in `routes/-chat/`, whose own comment argued the two inputs were too
 * different to share. They were not: `null` doubles as the closed state, so the
 * looser signature carries the open/closed rule as well.
 */
export function DeleteThreadDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: { title: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(open) => (open ? undefined : onCancel())}>
      {target ? (
        <DialogContent
          title="Delete chat?"
          description={`“${target.title}” and its messages will be permanently removed. This can’t be undone.`}
          // `themed` stamps `.app` AND the resolved theme through the portal.
          // Hand-stamping only `.app` left the panel dark in light mode, since
          // nothing resolved `data-app-theme` outside the app subtree.
          themed
          className="max-w-sm"
        >
          <div className="flex justify-end gap-2 px-6 pt-2 pb-5">
            <AppButton variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </AppButton>
            <AppButton variant="destructive" size="md" onClick={onConfirm}>
              Delete
            </AppButton>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
