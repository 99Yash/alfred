import { ArrowUp, AtSign, Check, Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";
import { ApprovalModePicker } from "../approval-mode-picker";
import { ModelTierPicker, type ChatTier } from "../model-tier-picker";
import { useMicRecording } from "../mic-recording";
import { Tip } from "../tip";

export function ComposerToolbar({
  mic,
  canSend,
  isStreaming,
  disabled,
  sending,
  mentionActive,
  onMentionClick,
  onAttachClick,
  transcribing,
  voiceError,
  onVoiceStart,
  onVoiceConfirm,
  onStopGeneration,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
}: {
  mic: ReturnType<typeof useMicRecording>;
  canSend: boolean;
  isStreaming: boolean;
  disabled: boolean;
  sending: boolean;
  mentionActive: boolean;
  onMentionClick: () => void;
  onAttachClick: () => void;
  transcribing: boolean;
  voiceError: string | null;
  onVoiceStart: () => void;
  onVoiceConfirm: () => void;
  onStopGeneration?: () => void;
  autoApprove?: boolean;
  autoApprovePending?: boolean;
  onToggleAutoApprove?: () => void;
  tier: ChatTier;
  onTierChange: (tier: ChatTier) => void;
}) {
  const statusMessage = voiceError ?? mic.error;
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
      <div className="flex items-center gap-1">
        <Tip label="Attach image">
          <ComposerIcon
            label="Attach image"
            disabled={disabled || mic.recording}
            onClick={onAttachClick}
          >
            <Paperclip size={14} />
          </ComposerIcon>
        </Tip>
        <Tip label="Mention a source" keys={["@"]}>
          <ComposerIcon
            label="Mention a source"
            disabled={disabled || mic.recording}
            onClick={onMentionClick}
            active={!disabled && mentionActive}
          >
            <AtSign size={14} />
          </ComposerIcon>
        </Tip>
        <ModelTierPicker
          value={tier}
          onChange={onTierChange}
          disabled={disabled || mic.recording}
        />
        {onToggleAutoApprove ? (
          <ApprovalModePicker
            on={Boolean(autoApprove)}
            disabled={Boolean(autoApprovePending)}
            onToggle={onToggleAutoApprove}
          />
        ) : null}
        {transcribing ? (
          <span className="animate-chat-shimmer pl-1 text-[11px] text-app-fg-3">Transcribing…</span>
        ) : statusMessage ? (
          <span className="pl-1 text-[11px] text-app-red-4">{statusMessage}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {mic.recording ? (
          <>
            {/* Voice mode: X discards the take, ✓ sends it to transcription. */}
            <Tip label="Discard recording">
              <ComposerIcon label="Discard recording" onClick={mic.cancel}>
                <X size={14} />
              </ComposerIcon>
            </Tip>
            <Tip label="Use recording">
              <button
                type="button"
                onClick={onVoiceConfirm}
                aria-label="Use recording"
                className={cn(
                  "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                  "app-press transition-[opacity,filter,transform]",
                  "hover:scale-[1.04] active:scale-[0.97]",
                  "text-(--app-accent-fg)",
                  "bg-(image:--app-cta-bg)",
                  "shadow-(--app-button-primary-shadow)",
                  "hover:brightness-[1.06]",
                  "hover:shadow-(--app-button-primary-shadow-hover)",
                  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                  "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
                )}
              >
                <Check size={16} strokeWidth={2.5} />
              </button>
            </Tip>
          </>
        ) : (
          <>
            <Tip label="Dictate">
              <ComposerIcon
                label="Dictate"
                onClick={onVoiceStart}
                disabled={disabled || transcribing}
              >
                {transcribing ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
              </ComposerIcon>
            </Tip>
            {isStreaming && onStopGeneration ? (
              <Tip label="Stop generating">
                <button
                  type="button"
                  onClick={onStopGeneration}
                  aria-label="Stop generating"
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    "app-press transition-[opacity,filter,transform]",
                    "bg-app-red-4 text-white",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_rgba(255,47,0,0.32)]",
                    "hover:brightness-[1.05]",
                    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                    "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
                  )}
                >
                  <Square size={12} strokeWidth={2.5} fill="currentColor" />
                </button>
              </Tip>
            ) : (
              <Tip label="Send" keys={["↵"]}>
                <button
                  type="submit"
                  disabled={!canSend}
                  aria-label={
                    sending
                      ? "Sending"
                      : disabled
                        ? "Waiting for approval"
                        : isStreaming
                          ? "Waiting for response"
                          : "Send"
                  }
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    "app-press transition-[opacity,filter,transform]",
                    "active:scale-[0.97] enabled:hover:scale-[1.04]",
                    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                    "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
                    canSend
                      ? cn(
                          "text-(--app-accent-fg)",
                          "bg-(image:--app-cta-bg)",
                          "shadow-(--app-button-primary-shadow)",
                          "hover:brightness-[1.06]",
                          "hover:shadow-(--app-button-primary-shadow-hover)",
                        )
                      : "cursor-not-allowed bg-app-bg-2 text-app-fg-2",
                  )}
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </button>
              </Tip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ComposerIcon({
  label,
  children,
  disabled,
  onClick,
  active,
  ref,
  ...rest
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={onClick ? Boolean(active) : undefined}
      disabled={disabled}
      onClick={onClick}
      {...rest}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full",
        "app-press transition-colors",
        active
          ? "bg-app-purple-1 text-app-purple-4"
          : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-app-fg-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      {children}
    </button>
  );
}
