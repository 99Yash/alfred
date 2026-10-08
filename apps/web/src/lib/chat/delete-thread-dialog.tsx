import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppButton } from "~/components/ui/v2";

/** Delete confirmation for the sidebar and header menus. A `null` target means closed. */
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
          // `themed` carries the theme through the portal; without it the panel stays dark.
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
