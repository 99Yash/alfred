import { AlertTriangle } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * The notice on a may-have-run card, in the approvals list and in the chat dock. The call started
 * once and did not finish, so its effect may already exist.
 */
export function MayHaveRunNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-surface bg-app-amber-1 px-3 leading-5 text-app-amber-4 shadow-[0_0_0_1px_var(--app-amber-2)]",
        compact ? "mt-2 py-2 text-[12px]" : "py-2.5 text-xs",
      )}
    >
      <AlertTriangle size={compact ? 14 : 15} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">This may have already run.</p>
        <p className="mt-0.5 opacity-80">
          Alfred stopped before it could confirm. Check first, then decide.
        </p>
      </div>
    </div>
  );
}
