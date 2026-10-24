import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type SubmitEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { JSONContent } from "@tiptap/react";
import { CornerDownRight, ImagePlus, Pencil, X } from "lucide-react";
import { ACCEPT_ATTR } from "~/lib/chat/upload-attachments";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { safeGet, safeRemove, safeSet } from "~/lib/storage/storage";
import { MicWaveform } from "../mic-recording";
import {
  CHAT_TEXT_ATTACHMENT_MAX_CHARACTERS,
  isEmptyChatTurnInput,
  type ChatModelTier,
} from "@alfred/contracts";
import { TiptapComposer, type TiptapComposerHandle } from "../tiptap-composer";
import { AttachmentChips } from "./attachment-chips";
import { ComposerToolbar } from "./composer-toolbar";
import { QueueTray } from "./queue-tray";
import { useSteerModifier } from "./use-steer-modifier";
import { quoteMessage, replaceQuotedBody, splitQuote } from "../quote";
import { useMentionConnections } from "../mention-connection";
import { MentionPalette } from "./mention-palette";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerDraft } from "./use-composer-draft";
import { useComposerVoice } from "./use-composer-voice";
import { useMentionController } from "./use-mention-controller";
import { useTypeAnywhere } from "./use-type-anywhere";
import { KeyHint } from "./key-hint";
import type { QueuedEdit, QueuedMessage } from "~/lib/chat/use-chat-queue";
import type { ChatApprovalMode } from "../approval-mode-options";

/** A text paste at or over this length becomes a `.txt` attachment (about 4 KB, as in Dimension). */
const LARGE_PASTE_MIN_CHARACTERS = 4_000;

/** A queued message loaded into the editor for an edit. */
interface QueueEditSession {
  id: string;
  /** The message's quote. `null` once the user removes it. */
  quote: string | null;
  /** The draft and files that the edit moved aside. They come back when the edit ends. */
  stash: { json: JSONContent; files: File[] };
}

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
  approvalMode,
  approvalModePending,
  onApprovalModeChange,
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
  sendingQueuedId,
  queuePaused,
  onResumeQueue,
  quote,
  onClearQuote,
  dock,
  onApproveShortcut,
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
  /** Chat approval mode. Absent hides the control. */
  approvalMode?: ChatApprovalMode | undefined;
  /** Policy still loading: disable the picker. */
  approvalModePending?: boolean | undefined;
  onApprovalModeChange?: ((mode: ChatApprovalMode) => void) | undefined;
  tier: ChatModelTier;
  onTierChange: (tier: ChatModelTier) => void;
  /** Queued messages for this thread, shown as chips (#489). */
  queued?: QueuedMessage[] | undefined;
  onRemoveQueued?: ((id: string) => void) | undefined;
  /** Move a queued message to the head and stop the reply, so it sends next. */
  onSendQueuedNow?: ((id: string) => void) | undefined;
  /** Replace a queued message's text and files, from an edit in this composer. */
  onUpdateQueued?: ((id: string, patch: QueuedEdit) => void) | undefined;
  /** The queued message loaded into this composer for an edit. The flush waits while it is next. */
  editingQueuedId?: string | null | undefined;
  onEditingQueuedChange?: ((id: string | null) => void) | undefined;
  /** The queued message a steer stopped the reply for. */
  steeringQueuedId?: string | null | undefined;
  /** The queued message with a send in flight, at any position. */
  sendingQueuedId?: string | null | undefined;
  /** Stop held the queue. It waits for Resume. */
  queuePaused?: boolean | undefined;
  onResumeQueue?: (() => void) | undefined;
  /** Text quoted from a reply. It is sent as a blockquote ahead of the message. */
  quote?: string | null | undefined;
  onClearQuote?: (() => void) | undefined;
  /** The approval dock. It sits above the queue tray, and both tuck under the composer. */
  dock?: ReactNode | undefined;
  /** ⌘↵ in an empty composer runs this, the docked card's primary action. */
  onApproveShortcut?: (() => void) | undefined;
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

  // A send cannot start: an approval or a question waits, or a send runs.
  const composerDisabled = disabled || sending;

  // Edit loads a queued message into this editor, so the edit has the full composer: files,
  // drop, paste, voice, mentions. The draft waits in the session and comes back after.
  // The ref is for the editor callbacks, which run before the state commits.
  const [edit, setEdit] = useState<QueueEditSession | null>(null);
  const editRef = useRef<QueueEditSession | null>(null);

  const putEdit = useCallback((next: QueueEditSession | null) => {
    editRef.current = next;
    setEdit(next);
  }, []);

  // An edit changes only the queue, so an approval that arrives during it does not lock the editor.
  // The edit can still save or cancel. It cannot send now.
  const inputDisabled = composerDisabled && edit === null;

  // Stays enabled while streaming, so submits queue (#489). An emptied edit can save: it removes the message.
  const canSend =
    !inputDisabled &&
    (edit !== null || !isEmpty || hasAttachments) &&
    !mic.recording &&
    !transcribing;

  const insertAtTrigger = useCallback(() => {
    if (inputDisabled) return;
    editorRef.current?.insertAtTrigger();
  }, [inputDisabled]);

  useTypeAnywhere(editorRef, composerDisabled);

  // Keyed on the nonce. Skipped while disabled (pending approval) or during an edit.
  const appliedPrefillNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || disabled || sending || edit) return;

    // The Composer remounts per thread; skip a prefill from another thread.
    if (prefill.threadId !== threadId) return;

    if (appliedPrefillNonce.current === prefill.nonce) return;
    appliedPrefillNonce.current = prefill.nonce;
    setArtifactTargetId(prefill.artifactTargetId);
    editorRef.current?.insertText(prefill.text);
  }, [prefill, disabled, sending, edit, threadId, setArtifactTargetId]);

  // A new quote puts the caret in the editor, so the user types the question next.
  useEffect(() => {
    if (quote) editorRef.current?.focusEnd();
  }, [quote]);

  const handleEditorChange = useCallback(
    (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => {
      // The stored draft is the one in the stash, not the queued message.
      const editing = editRef.current !== null;
      onEditorChange(nextText, nextJSON, nextEmpty, !editing);

      if (nextEmpty && !editing) setArtifactTargetId(undefined);
    },
    [onEditorChange, setArtifactTargetId],
  );

  const onAttachClick = useCallback(() => {
    if (inputDisabled || mic.recording) return;
    fileInputRef.current?.click();
  }, [inputDisabled, mic.recording]);

  const beginEdit = useCallback(
    (id: string) => {
      const item = queued?.find((m) => m.id === id);
      const editor = editorRef.current;

      if (!item || !editor || editRef.current) return;
      const { quote: itemQuote, body } = splitQuote(item.text);
      const stash = { json: editor.getJSON(), files: attachments.replace(item.files) };
      putEdit({ id, quote: itemQuote, stash });
      editor.setText(body);
      onEditingQueuedChange?.(id);
    },
    [queued, attachments, putEdit, onEditingQueuedChange],
  );

  const endEdit = useCallback(() => {
    const session = editRef.current;

    if (!session) return;
    putEdit(null);
    attachments.replace(session.stash.files);
    // After `putEdit`, so the update stores the draft again.
    editorRef.current?.setJSON(session.stash.json);
    onEditingQueuedChange?.(null);
  }, [attachments, putEdit, onEditingQueuedChange]);

  // The message can leave the queue during the edit (Remove, or a send). Then the draft comes back.
  const editGone = edit !== null && !queued?.some((m) => m.id === edit.id);
  useEffect(() => {
    if (editGone) endEdit();
  }, [editGone, endEdit]);

  // ↵ saves in place. ⌘↵ saves and sends it now, the same as the row's send now.
  const saveEdit = useCallback(
    (mode: "send" | "steer") => {
      const session = editRef.current;
      const item = queued?.find((m) => m.id === session?.id);

      if (!session || !item) return;
      const body = text.trim();
      const files = attachments.files();
      const sendNow = mode === "steer" && !composerDisabled ? onSendQueuedNow : undefined;
      endEdit();

      // The editor does not show a retry's stored attachments, so they keep the message alive.
      if (
        isEmptyChatTurnInput({
          content: body,
          hasFiles: files.length > 0,
          artifactTargetId: item.artifactTargetId,
          retryAttachmentIds: item.retryAttachmentIds,
        })
      ) {
        onRemoveQueued?.(item.id);

        return;
      }

      // The quote lines stay byte for byte, unless the user removed the quote.
      const next = session.quote ? replaceQuotedBody(item.text, body) : body;
      onUpdateQueued?.(item.id, { text: next, files });
      sendNow?.(item.id);
    },
    [
      queued,
      text,
      attachments,
      composerDisabled,
      endEdit,
      onRemoveQueued,
      onUpdateQueued,
      onSendQueuedNow,
    ],
  );

  const submit = useCallback(
    (mode: "send" | "steer") => {
      // ⌘↵ with nothing typed approves the docked card. With a draft, it queues the draft.
      if (mode === "steer" && onApproveShortcut && !editRef.current && isEmpty && !hasAttachments) {
        onApproveShortcut();

        return;
      }

      if (editRef.current) {
        if (canSend) saveEdit(mode);

        return;
      }

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
      onApproveShortcut,
      isEmpty,
      hasAttachments,
      canSend,
      saveEdit,
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

  const onFormSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit();
  };

  // Esc cancels an edit. The mention palette handles its own Esc first and prevents the default.
  const onFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape" || !editRef.current || e.defaultPrevented) return;
    e.stopPropagation();
    endEdit();
  };

  // The quote chip shows the edited message's quote during an edit, and the pending quote otherwise.
  const shownQuote = edit ? edit.quote : quote;

  const clearEditQuote = useCallback(() => {
    const session = editRef.current;

    if (session) putEdit({ ...session, quote: null });
  }, [putEdit]);

  const clearShownQuote = edit ? clearEditQuote : onClearQuote;

  const onDragEnter = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes("Files") || inputDisabled) return;
      dragDepth.current += 1;
      setIsDragging(true);
    },
    [inputDisabled],
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

      if (inputDisabled) return;
      attachments.addFiles(e.dataTransfer.files);
    },
    [inputDisabled, attachments],
  );

  // Dimension's rule: a long paste becomes a text file, so the message and its bubble stay short.
  const onPasteText = useCallback(
    (text: string): boolean => {
      if (edit || inputDisabled || text.length < LARGE_PASTE_MIN_CHARACTERS) return false;

      if (text.length > CHAT_TEXT_ATTACHMENT_MAX_CHARACTERS) {
        toast.error(
          `This paste is too long to attach. The limit is ${CHAT_TEXT_ATTACHMENT_MAX_CHARACTERS.toLocaleString()} characters.`,
        );

        return true;
      }

      attachments.addFiles([new File([text], "Pasted text.txt", { type: "text/plain" })]);

      return true;
    },
    [edit, inputDisabled, attachments],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(e.clipboardData.files);

      if (files.length === 0) return;
      // Only for pasted files; text paste falls through.
      e.preventDefault();

      if (inputDisabled) return;
      attachments.addFiles(files);
    },
    [inputDisabled, attachments],
  );

  return (
    <div className="flex flex-col gap-2">
      {dock}
      {queued && queued.length > 0 && onRemoveQueued ? (
        <QueueTray
          items={queued}
          isStreaming={isStreaming}
          canSteer={Boolean(onSteer)}
          steeringId={steeringQueuedId}
          sendingId={sendingQueuedId}
          paused={queuePaused}
          onResume={onResumeQueue}
          editingId={editingQueuedId}
          // One edit at a time. The composer cannot load a message while it is disabled,
          // or while voice input owns the editor.
          onEdit={
            onUpdateQueued && !composerDisabled && !edit && !mic.recording && !transcribing
              ? beginEdit
              : undefined
          }
          onRemove={onRemoveQueued}
          onSendNow={composerDisabled ? undefined : onSendQueuedNow}
        />
      ) : null}
      <form
        ref={formRef}
        onSubmit={onFormSubmit}
        onKeyDown={onFormKeyDown}
        aria-label={edit ? "Edit a queued message" : "Send a message"}
        data-disabled={inputDisabled || undefined}
        // Above the queue tray, which tucks under the top edge.
        className="relative z-10"
      >
        {!inputDisabled && suggestion && mentionCandidates.length > 0 ? (
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
            "composer-frost @container/composer relative overflow-hidden rounded-panel p-2",
            // Frosted surface (see `.composer-frost`).
            "shadow-[var(--frost-shadow)]",
            "app-focus-within transition-shadow",
            disabled && !edit && "opacity-70",
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
              "pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-panel bg-app-background/70 backdrop-blur-sm",
              "transition-opacity duration-100 motion-reduce:transition-none",
              isDragging && !inputDisabled ? "opacity-100" : "opacity-0",
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
              disabled={inputDisabled}
              aria-label="Attach files"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) attachments.addFiles(e.target.files);
                // So picking the same file again fires change.
                e.target.value = "";
              }}
            />
            {edit ? (
              <div className="app-fade-in mx-1 mb-1 flex items-center gap-2 py-1 pr-1 pl-2">
                <Pencil size={13} aria-hidden className="shrink-0 text-app-purple-4" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-app-fg-3">
                  Editing a queued message
                </span>
                <KeyHint
                  keys="esc"
                  className="text-[11px] text-app-fg-2 [@media(pointer:coarse)]:hidden"
                >
                  Cancel
                </KeyHint>
                <button
                  type="button"
                  aria-label="Cancel the edit"
                  onClick={endEdit}
                  className={cn(
                    "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
                    "text-app-fg-3 transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
                    "app-focus",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {shownQuote && (edit || onClearQuote) ? (
              <div className="app-fade-in mx-1 mb-1 flex items-start gap-2 rounded-surface bg-app-bg-a2 py-2 pr-2 pl-3">
                <CornerDownRight size={14} aria-hidden className="mt-0.5 shrink-0 text-app-fg-2" />
                <p className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug whitespace-pre-wrap text-app-fg-3">
                  {shownQuote}
                </p>
                <button
                  type="button"
                  aria-label="Remove quote"
                  onClick={clearShownQuote}
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
                disabled={inputDisabled}
                onRemove={attachments.remove}
              />
            ) : null}
            {/* Hidden, not unmounted, while recording, so the transcript appends to typed text. */}
            <div className={cn(mic.recording && "hidden")}>
              <TiptapComposer
                ref={editorRef}
                initialJSON={initialJSON}
                placeholder={
                  edit
                    ? "Clear it to remove it from the queue"
                    : isStreaming
                      ? onSteer
                        ? "Queue a follow-up, or steer the reply…"
                        : "Queue a follow-up…"
                      : "Type and press enter to start chatting…"
                }
                disabled={inputDisabled}
                onChange={handleEditorChange}
                onSubmit={handleSubmit}
                onSubmitNow={handleSteer}
                onSuggestionChange={mention.setSuggestion}
                suggestionKeyDownRef={suggestionKeyDownRef}
                ghostText={edit ? undefined : ghostText}
                onGhostAccept={onGhostAccept}
                onGhostDismiss={onGhostDismiss}
                onPasteText={onPasteText}
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
              editing={edit !== null}
              editCanSendNow={!composerDisabled}
              onSteer={handleSteer}
              disabled={inputDisabled}
              sending={sending}
              mentionActive={suggestion !== null}
              onMentionClick={insertAtTrigger}
              onAttachClick={onAttachClick}
              transcribing={transcribing}
              voiceError={voiceError}
              onVoiceStart={onVoiceStart}
              onVoiceConfirm={() => void onVoiceConfirm()}
              onStopGeneration={onStopGeneration}
              approvalMode={approvalMode}
              approvalModePending={approvalModePending}
              onApprovalModeChange={onApprovalModeChange}
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
  levelsRef: RefObject<Float32Array | null>;
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
