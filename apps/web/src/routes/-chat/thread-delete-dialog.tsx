import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppButton, useAppTheme } from "~/components/ui/v2";

/**
 * Delete confirmation for the thread you are reading.
 *
 * A near-twin of the sidebar's `DeleteThreadDialog`, kept separate rather than
 * shared because the two take different inputs: the sidebar's is driven by a
 * `ThreadEntry` from its own view model, while the header only knows a title.
 * Folding them together would mean giving the sidebar's dialog a second,
 * looser signature to satisfy this caller — more coupling than the handful of
 * lines it would save.
 */
export function ThreadDeleteDialog({
  title,
  open,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { resolved } = useAppTheme();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Delete chat?"
        description={`“${title}” and its messages will be permanently removed. This can’t be undone.`}
        className="app max-w-sm"
        data-app-theme={resolved}
      >
        <div className="flex justify-end gap-2 px-6 pt-2 pb-5">
          <AppButton variant="ghost" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </AppButton>
          <AppButton variant="destructive" size="md" onClick={onConfirm}>
            Delete
          </AppButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
