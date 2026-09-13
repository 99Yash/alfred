import type { SharedThreadSummary } from "@alfred/contracts";
import { Check, Copy, Globe, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppButton, useAppTheme } from "~/components/ui/v2";
import {
  sharedThreadUrl,
  useRevokeShare,
  useShareThread,
  useThreadShares,
} from "~/lib/sharing/use-thread-sharing";
import { callToast } from "~/lib/toast";
import { cn } from "~/lib/utils";

/**
 * The Share control's dialog (ADR-0102).
 *
 * Two things about this surface are deliberate and should survive a redesign.
 *
 * NOTHING IS PUBLISHED UNTIL THE USER PRESSES THE BUTTON. Opening the dialog
 * only lists shares that already exist. A dialog that published on open would
 * make an accidental click a disclosure.
 *
 * THE DIALOG STATES WHAT TRAVELS. A visitor sees the transcript and Alfred's
 * reasoning; they do not see tool results, token costs, or attachments. Users
 * cannot reason about a privacy control they have to infer, so the copy says it
 * rather than relying on the reader having read the ADR.
 */

/** Time-boxed "Copied" acknowledgement on the copy button. */
function useCopiedFlag() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return {
    copied,
    flag: () => {
      setCopied(true);

      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    },
  };
}

function ShareRow({
  share,
  onRevoke,
  revoking,
}: {
  share: SharedThreadSummary;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const url = sharedThreadUrl(share.urlSlug);
  const { copied, flag } = useCopiedFlag();

  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => {
        flag();
        callToast({ message: "Link copied", variant: "success" });
      },
      () => {
        // Clipboard writes fail on an insecure context or a denied permission.
        // The URL is on screen and selectable, so this is a nudge, not an error.
        callToast({
          message: "Could not copy the link. Select it and copy manually.",
          variant: "warning",
        });
      },
    );
  };

  return (
    <div className="rounded-xl border border-app-bg-3/70 bg-app-bg-2/40 p-3">
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          aria-label="Public link to this thread"
          onFocus={(event) => event.currentTarget.select()}
          className={cn(
            "min-w-0 flex-1 truncate rounded-lg bg-app-bg-1 px-2.5 py-1.5",
            "font-mono text-xs text-app-fg-3",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
          )}
        />
        <AppButton
          variant="white"
          size="sm"
          onClick={copy}
          leading={copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        >
          {copied ? "Copied" : "Copy"}
        </AppButton>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
        <span className="truncate text-xs text-app-fg-2">
          {share.messageCount} {share.messageCount === 1 ? "message" : "messages"} · shared{" "}
          {new Date(share.sharedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
        <button
          type="button"
          onClick={onRevoke}
          disabled={revoking}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium",
            "text-app-fg-2 transition-colors hover:bg-app-red-1 hover:text-app-red-4",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {revoking ? (
            <Loader2 size={12} aria-hidden className="animate-spin" />
          ) : (
            <Trash2 size={12} aria-hidden />
          )}
          Revoke
        </button>
      </div>
    </div>
  );
}

export function ShareThreadDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { resolved } = useAppTheme();
  const shares = useThreadShares(threadId, open);
  const share = useShareThread(threadId);
  const revoke = useRevokeShare(threadId);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const rows = shares.data ?? [];

  const onRevoke = (id: string) => {
    setRevokingId(id);
    revoke.mutate(id, {
      onSuccess: () => callToast({ message: "Link revoked", variant: "success" }),
      onError: () => callToast({ message: "Could not revoke the link.", variant: "error" }),
      onSettled: () => setRevokingId(null),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Share this thread"
        description="Anyone with the link can read this conversation. They do not need an Alfred account."
        className="app max-w-lg"
        data-app-theme={resolved}
      >
        <div className="flex flex-col gap-3 px-6 pt-1 pb-5">
          <p className="text-xs leading-relaxed text-app-fg-2">
            A link publishes a frozen copy: the messages, Alfred&rsquo;s reasoning, and any finished
            artifacts, as they read right now. Later turns stay private until you share again. Tool
            results, attachments, and usage costs are never published.
          </p>

          {shares.isLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-app-fg-2">
              <Loader2 size={14} aria-hidden className="animate-spin" />
              Checking for existing links&hellip;
            </div>
          ) : null}

          {rows.map((row) => (
            <ShareRow
              key={row.id}
              share={row}
              onRevoke={() => onRevoke(row.id)}
              revoking={revokingId === row.id}
            />
          ))}

          {shares.isError ? (
            <p className="text-xs text-app-red-4">Could not load existing links.</p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <AppButton variant="ghost" size="md" onClick={() => onOpenChange(false)}>
              Done
            </AppButton>
            <AppButton
              variant="primary"
              size="md"
              loading={share.isPending}
              disabled={!threadId}
              leading={<Globe size={14} aria-hidden />}
              onClick={() =>
                share.mutate(undefined, {
                  onError: () =>
                    callToast({ message: "Could not create a link.", variant: "error" }),
                })
              }
            >
              {rows.length > 0 ? "Publish current version" : "Create public link"}
            </AppButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
