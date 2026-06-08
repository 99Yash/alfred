import { ShieldCheck, SquareCheckBig } from "lucide-react";
import type { ReactNode } from "react";
import { FrostButton } from "~/components/landing";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { IntegrationIcon } from "~/lib/integration-icons";

/**
 * Pre-OAuth consent coaching. Borrowed from dimension's
 * `google-permission-gif-dialog`, adapted for Alfred's single-tenant,
 * Production-unverified posture (ADR-0044, amended 2026-06-08): one consent
 * grants the full Workspace surface, so the two things that actually sink a
 * broad grant get coached up-front —
 *
 *   1. Google's consent screen shows per-scope checkboxes the user can
 *      *uncheck*. A broad grant makes that the #1 failure mode, so we tell
 *      them to leave every box ticked.
 *   2. An unverified app shows a scary "Google hasn't verified this app"
 *      interstitial. dimension (verified) never hit this; Alfred always does.
 *      We pre-explain the Advanced → Go to Alfred click so it doesn't read as
 *      a dead end.
 *
 * `onConfirm` performs the actual full-page redirect to the connect endpoint.
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
        <div className="px-6 pb-6 pt-1">
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
                  Google will warn the app isn&apos;t verified — expected for a private app
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
