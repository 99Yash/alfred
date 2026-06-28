import { ArrowUp, AtSign, Mic, Paperclip, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { AppPill } from "~/components/ui/v2";
import { cn } from "~/lib/utils";

const ADD_TOOL_LEADING = <Plus size={12} />;

export function ComposerDock({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const canSend = value.trim().length > 0;
  return (
    <div className="shrink-0 pt-1 pb-5">
      <div className="mx-auto w-full max-w-3xl px-6">
        <div className={cn("app-elevated rounded-3xl bg-app-bg-1 p-2")}>
          <textarea
            aria-label="Ask Alfred"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Ask Alfred…"
            rows={2}
            className={cn(
              "block w-full resize-none bg-transparent px-2.5 pt-2 text-sm text-app-fg-4 placeholder:text-app-fg-2",
              "outline-none focus-visible:outline-none",
            )}
          />

          <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
            <div className="flex items-center gap-1.5">
              <ComposerIcon label="Attach file">
                <Paperclip size={14} />
              </ComposerIcon>
              <ComposerIcon label="Mention source">
                <AtSign size={14} />
              </ComposerIcon>
              <AppPill className="h-7 px-2.5 text-[12px]" leading={ADD_TOOL_LEADING} chevron>
                Add tool
              </AppPill>
            </div>

            <div className="flex items-center gap-1.5">
              <ComposerIcon label="Dictate">
                <Mic size={14} />
              </ComposerIcon>
              <button
                type="button"
                disabled={!canSend}
                aria-label="Send message"
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-lg",
                  "app-press transition-[box-shadow,transform,filter]",
                  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
                  canSend
                    ? cn(
                        "text-[var(--app-accent-fg)]",
                        "bg-[image:var(--app-cta-bg)]",
                        "shadow-[var(--app-button-primary-shadow)]",
                        "hover:brightness-[1.06]",
                      )
                    : "cursor-not-allowed bg-app-bg-2 text-app-fg-2",
                )}
              >
                <ArrowUp size={15} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-app-fg-2">
          Alfred can call tools across Gmail, Calendar, and your memory.
        </p>
      </div>
    </div>
  );
}

function ComposerIcon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-lg",
        "app-press text-app-fg-3 transition-colors hover:bg-app-bg-a2 hover:text-app-fg-4",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      {children}
    </button>
  );
}
