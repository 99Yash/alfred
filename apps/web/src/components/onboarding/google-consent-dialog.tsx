import { ShieldCheck, SquareCheckBig } from "lucide-react";
import type { ReactNode } from "react";
import { FrostButton } from "~/components/landing";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";

/**
 * Coaching before Google OAuth (ADR-0044). Tells the user to leave every scope
 * box ticked and how to pass the unverified-app screen (Advanced → Go to Alfred).
 * `onConfirm` does the full-page redirect.
 */
export function GoogleConsentDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect Google Workspace"
        description="Two quick things before Google takes over the next two screens."
      >
        <div className="px-6 pt-1 pb-6">
          <div className="mb-5 flex items-center gap-2">
            <IntegrationIcon brand="gmail" size="sm" />
            <IntegrationIcon brand="google_calendar" size="sm" />
            <IntegrationIcon brand="google_drive" size="sm" />
            <IntegrationIcon brand="google_docs" size="sm" />
          </div>

          <ol className="space-y-4">
            <ConsentStep
              icon={<SquareCheckBig size={18} strokeWidth={2} className="text-emerald-400" />}
              title="Check every box"
              body="Leave all permissions enabled so Alfred can work across your mail, calendar, and files. Unchecking any box quietly disables the matching feature."
            />
            <ConsentStep
              icon={<ShieldCheck size={18} strokeWidth={2} className="text-amber-300" />}
              title="Continue past the safety screen"
              body={
                <>
                  Google will warn the app isn&apos;t verified, which is expected for a private app
                  that&apos;s only ever used by you. Click{" "}
                  <span className="font-medium text-white">Advanced</span> →{" "}
                  <span className="font-medium text-white">Go to Alfred</span> to continue.
                </>
              }
            />
          </ol>

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-full px-3.5 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white"
            >
              Cancel
            </button>
            <FrostButton tone="light" size="md" onClick={onConfirm}>
              Continue to Google
            </FrostButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConsentStep({ icon, title, body }: { icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.06] ring-1 ring-white/10">
        {icon}
      </span>
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="text-[13px] leading-relaxed text-white/70">{body}</p>
      </div>
    </li>
  );
}
