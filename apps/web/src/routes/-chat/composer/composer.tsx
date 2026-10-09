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
import { CornerDownRight, ImagePlus, X } from "lucide-react";
import { ACCEPT_ATTR } from "~/lib/chat/upload-attachments";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { safeGet, safeRemove, safeSet } from "~/lib/storage/storage";
import { MicWaveform } from "../mic-recording";
import type { ChatModelTier } from "@alfred/contracts";
import { TiptapComposer, type TiptapComposerHandle } from "../tiptap-composer";
import { AttachmentChips } from "./attachment-chips";
import { ComposerToolbar } from "./composer-toolbar";
import { QueueTray } from "./queue-tray";
import { useSteerModifier } from "./use-steer-modifier";
import { quoteMessage } from "../quote";
import { useMentionConnections } from "../mention-connection";
import { MentionPalette } from "./mention-palette";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerDraft } from "./use-composer-draft";
import { useComposerVoice } from "./use-composer-voice";
import { useMentionController } from "./use-mention-controller";
import { useTypeAnywhere } from "./use-type-anywhere";
import type { QueuedMessage } from "~/lib/chat/use-chat-queue";

export function Composer({
  threadId,
  isStreaming,
  disabled = false,
  onSend,
  onSteer,
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
  queued,
  onRemoveQueued,
  onSendQueuedNow,
  onUpdateQueued,
  editingQueuedId,
  onEditingQueuedChange,
  steeringQueuedId,
  queueSendingHead,
  quote,
  onClearQuote,
}: {
  threadId: string | undefined;
  isStreaming: boolean;
  disabled?: boolean | undefined;
  onSend?:
    | ((text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>)
    | undefined;
  /** Stop the reply and send this next (#490), on ⌘↵. Absent when no reply can stop. */
  onSteer?:
    | ((text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>)
    | undefined;
  onStopGeneration?: (() => void) | undefined;
  /** Text to insert at the caret, e.g. "Suggest an edit" (ADR-0075 Phase 4). `nonce` lets a repeat re-apply. */
  prefill?: {
    artifactTargetId: string;
    text: string;
    nonce: number;
    threadId: string | undefined;
  } | null;
  /** Dimmed suggested prompt in the empty editor; Tab accepts. */
  ghostText?: string | undefined;
  onGhostAccept?: (() => void) | undefined;
  onGhostDismiss?: (() => void) | undefined;
  /** Chat "Auto" mode. Absent hides the control. */
  autoApprove?: boolean | undefined;
  /** Policy still loading: disable the toggle. */
  autoApprovePending?: boolean | undefined;
  onToggleAutoApprove?: (() => void) | undefined;
  tier: ChatModelTier;
  onTierChange: (tier: ChatModelTier) => void;
  /** Queued messages for this thread, shown as chips (#489). */
  queued?: QueuedMessage[] | undefined;
  onRemoveQueued?: ((id: string) => void) | undefined;
  /** Move a queued message to the head and stop the reply, so it sends next. */
  onSendQueuedNow?: ((id: string) => void) | undefined;
  /** Replace a queued message's text (an in-place edit). */
  onUpdateQueued?: ((id: string, text: string) => void) | undefined;
  /** The queued message open for an edit. The flush waits while it is next. */
  editingQueuedId?: string | null | undefined;
  onEditingQueuedChange?: ((id: string | null) => void) | undefined;
  /** The queued message a steer stopped the reply for. */
  steeringQueuedId?: string | null | undefined;
  /** The flush is sending the first queued message now. */
  queueSendingHead?: boolean | undefined;
  /** Text quoted from a reply. It is sent as a blockquote ahead of the message. */
  quote?: string | null | undefined;
  onClearQuote?: (() => void) | undefined;
}) {
  const editorRef = useRef<TiptapComposerHandle | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { initialJSON, text, isEmpty, onEditorChange, resetDraft } = useComposerDraft(threadId);
  const voice = useComposerVoice(editorRef);
  const connections = useMentionConnections();
  const mention = useMentionController(connections);
  const attachments = useComposerAttachments();
  const { mic, transcribing, voiceError, onVoiceStart, onVoiceConfirm } = voice;
  const { suggestion, mentionCandidates, visibleMentionIdx, suggestionKeyDownRef } = mention;
  const hasAttachments = attachments.items.length > 0;
  const [sending, setSending] = useState(false);
  // `dragDepth` counts nested enter/leave, so crossing a child does not flicker the overlay.
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const artifactTargetKey = `alfred:chat-artifact-target:${threadId ?? "new"}`;

  // Read only at submit, so it stays off the render path. Ignore a target with no draft.
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

  // Stays enabled while streaming, so submits queue (#489).
  const canSend =
    !composerDisabled &&
    !sending &&
    (!isEmpty || hasAttachments) &&
    !mic.recording &&
    !transcribing;

  const insertAtTrigger = useCallback(() => {
    if (disabled || sending) return;
    editorRef.current?.insertAtTrigger();
  }, [disabled, sending]);

  useTypeAnywhere(editorRef, composerDisabled);

  // Keyed on the nonce. Skipped while disabled (pending approval).
  const appliedPrefillNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || disabled || sending) return;

    // The Composer remounts per thread; skip a prefill from another thread.
    if (prefill.threadId !== threadId) return;

    if (appliedPrefillNonce.current === prefill.nonce) return;
    appliedPrefillNonce.current = prefill.nonce;
    setArtifactTargetId(prefill.artifactTargetId);
    editorRef.current?.insertText(prefill.text);
  }, [prefill, disabled, sending, threadId, setArtifactTargetId]);

  // A new quote puts the caret in the editor, so the user types the question next.
  useEffect(() => {
    if (quote) editorRef.current?.focusEnd();
  }, [quote]);

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

  const submit = useCallback(
    (mode: "send" | "steer") => {
      // ⌘↵ with nothing to stop is a plain send.
      const deliver = mode === "steer" && onSteer ? onSteer : onSend;

      if (!canSend || !deliver) return;
      const value = quote ? quoteMessage(quote, text.trim()) : text.trim();
      const files = attachments.files();
      setSending(true);
      void deliver(value, files, artifactTargetIdRef.current)
        .then((staged) => {
          if (!staged) return;
          editorRef.current?.clear();
          resetDraft();
          attachments.clear();
          setArtifactTargetId(undefined);
          onClearQuote?.();
        })
        .catch(() => toast.error("Couldn't send your message. Please try again."))
        .finally(() => setSending(false));
    },
    [
      canSend,
      quote,
      text,
      onSend,
      onSteer,
      resetDraft,
      attachments,
      setArtifactTargetId,
      onClearQuote,
    ],
  );

  const handleSubmit = useCallback(() => submit("send"), [submit]);
  const handleSteer = useCallback(() => submit("steer"), [submit]);
  const steerArmed = useSteerModifier(formRef, Boolean(onSteer));

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
      // Only for pasted files; text paste falls through.
      e.preventDefault();

      if (disabled || sending) return;
      attachments.addFiles(files);
    },
    [disabled, sending, attachments],
  );

  return (
    <div className="flex flex-col gap-2">
      {queued && queued.length > 0 && onRemoveQueued ? (
        <QueueTray
          items={queued}
          isStreaming={isStreaming}
          canSteer={Boolean(onSteer)}
          steeringId={steeringQueuedId}
          sendingHead={queueSendingHead}
          editingId={editingQueuedId}
          onEditingChange={onEditingQueuedChange}
          onUpdate={onUpdateQueued}
          onRemove={onRemoveQueued}
          onSendNow={composerDisabled ? undefined : onSendQueuedNow}
        />
      ) : null}
      <form
        ref={formRef}
        onSubmit={onFormSubmit}
        aria-label="Send a message"
        data-disabled={composerDisabled || undefined}
        // Above the queue tray, which tucks under the top edge.
        className="relative z-10"
      >
        {!composerDisabled && suggestion && mentionCandidates.length > 0 ? (
          <MentionPalette
            options={mentionCandidates}
            activeIdx={visibleMentionIdx}
            connections={connections}
            connectPrompt={mention.connectPrompt}
            onHover={mention.setMentionIdx}
            onPick={mention.pickMention}
            onConnect={mention.connectFromPrompt}
            onBackFromConnect={mention.backFromConnect}
            onClose={() => suggestion.dismiss()}
          />
        ) : null}
        <div
          className={cn(
            "composer-frost @container/composer relative overflow-hidden rounded-3xl p-2",
            // Frosted surface (see `.composer-frost`).
            "shadow-[var(--frost-shadow)]",
            "app-focus-within transition-shadow",
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
          {/* Always mounted, so one CSS transition fades both ways. No pointer events, so the drop lands below. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-3xl bg-app-background/70 backdrop-blur-sm",
              "transition-opacity duration-100 motion-reduce:transition-none",
              isDragging && !composerDisabled ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-medium tracking-tight text-app-fg-4">
              <ImagePlus size={16} className="text-app-purple-3" />
              Drop images to attach
            </span>
          </div>
          {/* Positioned so it paints above the frost's ::before rim. */}
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
                // So picking the same file again fires change.
                e.target.value = "";
              }}
            />
            {quote && onClearQuote ? (
              <div className="app-fade-in mx-1 mb-1 flex items-start gap-2 rounded-2xl bg-app-bg-a2 py-2 pr-2 pl-3">
                <CornerDownRight size={14} aria-hidden className="mt-0.5 shrink-0 text-app-fg-2" />
                <p className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug whitespace-pre-wrap text-app-fg-3">
                  {quote}
                </p>
                <button
                  type="button"
                  aria-label="Remove quote"
                  onClick={onClearQuote}
                  className={cn(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                    "text-app-fg-3 transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
                    "app-focus",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {hasAttachments ? (
              <AttachmentChips
                items={attachments.items}
                disabled={composerDisabled}
                onRemove={attachments.remove}
              />
            ) : null}
            {/* Hidden, not unmounted, while recording, so the transcript appends to typed text. */}
            <div className={cn(mic.recording && "hidden")}>
              <TiptapComposer
                ref={editorRef}
                initialJSON={initialJSON}
                placeholder={
                  isStreaming
                    ? onSteer
                      ? "Queue a follow-up, or steer the reply…"
                      : "Queue a follow-up…"
                    : "Type and press enter to start chatting…"
                }
                disabled={composerDisabled}
                onChange={handleEditorChange}
                onSubmit={handleSubmit}
                onSubmitNow={handleSteer}
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
              canSteer={Boolean(onSteer)}
              steerArmed={steerArmed}
              onSteer={handleSteer}
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
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;

  return `${m}:${s.toString().padStart(2, "0")}`;
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
