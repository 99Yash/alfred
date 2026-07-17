import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type RefObject,
} from "react";
import type { JSONContent } from "@tiptap/react";
import {
  AnimatePresence,
  domMax,
  LazyMotion,
  m,
  useReducedMotion,
} from "framer-motion";
import { ImagePlus } from "lucide-react";
import { ACCEPT_ATTR } from "~/lib/chat/upload-attachments";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { safeGet, safeRemove, safeSet } from "~/lib/storage/storage";
import { MicWaveform } from "../mic-recording";
import { formatElapsed } from "../mic-recording-format";
import type { ChatTier } from "../model-tier-picker";
import { TiptapComposer, type TiptapComposerHandle } from "../tiptap-composer";
import { AttachmentChips } from "./attachment-chips";
import { ComposerToolbar } from "./composer-toolbar";
import { MentionPalette } from "./mention-palette";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerDraft } from "./use-composer-draft";
import { useComposerVoice } from "./use-composer-voice";
import { useMentionController } from "./use-mention-controller";
import { useTypeAnywhere } from "./use-type-anywhere";

export function Composer({
  threadId,
  isStreaming,
  disabled = false,
  onSend,
  onStopGeneration,
  ghostText,
  onGhostAccept,
  onGhostDismiss,
  autoApprove,
  autoApprovePending,
  onToggleAutoApprove,
  tier,
  onTierChange,
  prefill,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  disabled?: boolean;
  onSend?: (text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>;
  onStopGeneration?: () => void;
  /**
   * Text to drop into the editor on demand (e.g. the artifact sidebar's
   * "Suggest an edit"). The `nonce` lets the same scaffold re-apply on a repeat
   * request; the editor inserts it at the caret and focuses (ADR-0075 Phase 4).
   */
  prefill?: {
    artifactTargetId: string;
    text: string;
    nonce: number;
    threadId: string | undefined;
  } | null;
  /** Suggested next prompt shown dimmed in the empty editor; Tab accepts. */
  ghostText?: string;
  onGhostAccept?: () => void;
  onGhostDismiss?: () => void;
  /** Chat "Auto" mode state + toggle; absent hides the control. */
  autoApprove?: boolean;
  /** Initial policy load hasn't resolved yet — disable the toggle until we
   *  know the current mode (the row may not exist; clicking creates it). */
  autoApprovePending?: boolean;
  onToggleAutoApprove?: () => void;
  /** Model-tier picker (Auto vs Deep) state + setter. */
  tier: ChatTier;
  onTierChange: (tier: ChatTier) => void;
}) {
  const reduce = useReducedMotion();
  const editorRef = useRef<TiptapComposerHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { initialJSON, text, isEmpty, onEditorChange, resetDraft } = useComposerDraft(threadId);
  const voice = useComposerVoice(editorRef);
  const mention = useMentionController();
  const attachments = useComposerAttachments();
  const { mic, transcribing, voiceError, onVoiceStart, onVoiceConfirm } = voice;
  const { suggestion, mentionCandidates, visibleMentionIdx, suggestionKeyDownRef } = mention;
  const hasAttachments = attachments.items.length > 0;
  const [sending, setSending] = useState(false);
  // File drag-over affordance. `dragDepth` counts enter/leave across nested
  // children so moving the cursor over the editor or chips doesn't flicker the
  // overlay off (dragleave fires for every child boundary crossed).
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const artifactTargetKey = `alfred:chat-artifact-target:${threadId ?? "new"}`;
  // Event-driven mutable state read only at submit time stays off the render
  // path. Seed once from the persisted draft's target (ignoring an orphaned
  // target that has no draft) with a lazy state initializer, so the ref starts
  // correct without a render-phase write.
  const [initialArtifactTarget] = useState<string | undefined>(() =>
    initialJSON ? (safeGet(artifactTargetKey) ?? undefined) : undefined,
  );
  const artifactTargetIdRef = useRef<string | undefined>(initialArtifactTarget);
  const setArtifactTargetId = useCallback(
    (targetId: string | undefined) => {
      artifactTargetIdRef.current = targetId;
      if (targetId) safeSet(artifactTargetKey, targetId);
      else safeRemove(artifactTargetKey);
    },
    [artifactTargetKey],
  );
  const composerDisabled = disabled || sending;
  const canSend =
    !composerDisabled &&
    !sending &&
    (!isEmpty || hasAttachments) &&
    !mic.recording &&
    !isStreaming &&
    !transcribing;

  const insertAtTrigger = useCallback(() => {
    if (disabled || sending) return;
    editorRef.current?.insertAtTrigger();
  }, [disabled, sending]);

  useTypeAnywhere(editorRef, composerDisabled);

  // Apply a "Suggest an edit" prefill from the artifact sidebar. Keyed on the
  // nonce so the same scaffold re-applies on a repeat click; `insertText`
  // focuses the editor at the caret. Skipped while the composer is disabled
  // (pending approval) so we don't fight a parked turn.
  const appliedPrefillNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || disabled || sending) return;
    // Ignore a prefill created for a different thread — the Composer remounts
    // per-thread, so without this a stale prefill would re-apply after the user
    // navigates away from the thread it was requested in.
    if (prefill.threadId !== threadId) return;
    if (appliedPrefillNonce.current === prefill.nonce) return;
    appliedPrefillNonce.current = prefill.nonce;
    setArtifactTargetId(prefill.artifactTargetId);
    editorRef.current?.insertText(prefill.text);
  }, [prefill, disabled, sending, threadId, setArtifactTargetId]);

  const handleEditorChange = useCallback(
    (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => {
      onEditorChange(nextText, nextJSON, nextEmpty);
      if (nextEmpty) setArtifactTargetId(undefined);
    },
    [onEditorChange, setArtifactTargetId],
  );

  const onAttachClick = useCallback(() => {
    if (disabled || sending || mic.recording) return;
    fileInputRef.current?.click();
  }, [disabled, sending, mic.recording]);

  const handleSubmit = useCallback(() => {
    if (!canSend || !onSend) return;
    const value = text.trim();
    const files = attachments.files();
    setSending(true);
    void onSend(value, files, artifactTargetIdRef.current)
      .then((staged) => {
        if (!staged) return;
        editorRef.current?.clear();
        resetDraft();
        attachments.clear();
        setArtifactTargetId(undefined);
      })
      .catch(() => toast.error("Couldn't send your message. Please try again."))
      .finally(() => setSending(false));
  }, [canSend, text, onSend, resetDraft, attachments, setArtifactTargetId]);

  const onFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit();
  };

  const onDragEnter = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes("Files") || composerDisabled) return;
      dragDepth.current += 1;
      setIsDragging(true);
    },
    [composerDisabled],
  );

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      dragDepth.current = 0;
      setIsDragging(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      if (disabled || sending) return;
      attachments.addFiles(e.dataTransfer.files);
    },
    [disabled, sending, attachments],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length === 0) return;
      // Only intercept when the clipboard carries files (pasted image); let
      // normal text paste fall through to the editor.
      e.preventDefault();
      if (disabled || sending) return;
      attachments.addFiles(files);
    },
    [disabled, sending, attachments],
  );

  return (
    <LazyMotion features={domMax}>
      <form
        onSubmit={onFormSubmit}
        aria-label="Send a message"
        data-disabled={composerDisabled || undefined}
        className="relative"
      >
        {!composerDisabled && suggestion && mentionCandidates.length > 0 ? (
          <MentionPalette
            options={mentionCandidates}
            activeIdx={visibleMentionIdx}
            onHover={mention.setMentionIdx}
            onPick={mention.insertMention}
            onClose={() => suggestion.dismiss()}
          />
        ) : null}
        <div
          className={cn(
            "composer-frost relative overflow-hidden rounded-3xl p-2",
            // Floating frosted-glass surface: a beveled gradient rim, backdrop
            // blur + specular sheen, and a layered drop shadow (ported from
            // dimension's input material, re-tokenized — see `.composer-frost`).
            // The drop shadow is fed through Tailwind's --tw-shadow so it composes
            // with the purple focus ring instead of being wiped by it.
            "shadow-[var(--frost-shadow)]",
            "focus-within:ring-2 focus-within:ring-app-purple-2 focus-within:ring-offset-4",
            "transition-shadow focus-within:ring-offset-app-background",
            disabled && "opacity-70",
            sending && "opacity-80",
          )}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onPaste={onPaste}
        >
          <AnimatePresence>
            {isDragging && !composerDisabled ? (
              <m.div
                key="drop-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.12 }}
                // pointer-events-none so the drop lands on the container beneath.
                className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-3xl bg-app-background/70 backdrop-blur-sm"
              >
                <span className="flex items-center gap-2 text-[13px] font-medium tracking-tight text-app-fg-4">
                  <ImagePlus size={16} className="text-app-purple-3" />
                  Drop images to attach
                </span>
              </m.div>
            ) : null}
          </AnimatePresence>
          {/* Wrap editor + controls in a positioned container so they paint
           * above the frost surface's beveled ::before rim (positioned siblings
           * with z-auto paint in tree order). */}
          <div className="relative">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              disabled={composerDisabled}
              aria-label="Attach files"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) attachments.addFiles(e.target.files);
                // Reset so picking the same file again re-fires change.
                e.target.value = "";
              }}
            />
            {hasAttachments ? (
              <AttachmentChips
                items={attachments.items}
                disabled={composerDisabled}
                onRemove={attachments.remove}
              />
            ) : null}
            {/* Keep the editor mounted (just hidden) while recording so its
             * content survives the voice round-trip — the transcript appends to
             * whatever was already typed instead of a remount reverting to the
             * mount-time draft. */}
            <div className={cn(mic.recording && "hidden")}>
              <TiptapComposer
                ref={editorRef}
                initialJSON={initialJSON}
                placeholder="Type and press enter to start chatting…"
                disabled={composerDisabled}
                onChange={handleEditorChange}
                onSubmit={handleSubmit}
                onSuggestionChange={mention.setSuggestion}
                suggestionKeyDownRef={suggestionKeyDownRef}
                ghostText={ghostText}
                onGhostAccept={onGhostAccept}
                onGhostDismiss={onGhostDismiss}
              />
            </div>
            {mic.recording ? (
              <RecordingPanel
                levelsRef={mic.levelsRef}
                elapsed={mic.elapsed}
                active={mic.recording}
              />
            ) : null}

            <ComposerToolbar
              mic={mic}
              canSend={canSend}
              isStreaming={isStreaming}
              disabled={composerDisabled}
              sending={sending}
              mentionActive={suggestion !== null}
              onMentionClick={insertAtTrigger}
              onAttachClick={onAttachClick}
              transcribing={transcribing}
              voiceError={voiceError}
              onVoiceStart={onVoiceStart}
              onVoiceConfirm={() => void onVoiceConfirm()}
              onStopGeneration={onStopGeneration}
              autoApprove={autoApprove}
              autoApprovePending={autoApprovePending}
              onToggleAutoApprove={onToggleAutoApprove}
              tier={tier}
              onTierChange={onTierChange}
            />
          </div>
        </div>
      </form>
    </LazyMotion>
  );
}

function RecordingPanel({
  levelsRef,
  elapsed,
  active,
}: {
  levelsRef: RefObject<Float32Array>;
  elapsed: number;
  active: boolean;
}) {
  return (
    <div className="relative flex h-[64px] items-center gap-3 px-3 pt-2 pb-1.5">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-tight text-app-fg-3 uppercase">
        <span aria-hidden className="chat-rec-dot size-1.5 rounded-full bg-app-red-4" />
        <span className="text-app-fg-4 tabular-nums">{formatElapsed(elapsed)}</span>
        <span className="text-app-fg-2">Listening</span>
      </span>
      <div className="h-12 flex-1">
        <MicWaveform levelsRef={levelsRef} active={active} />
      </div>
    </div>
  );
}
