import { useAutoAnimate } from "@formkit/auto-animate/react";
import { ArrowUp, CornerDownRight, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { QueuedMessage } from "~/lib/chat/use-chat-queue";
import { replaceQuotedBody, splitQuote } from "../quote";
import { Tip } from "../tip";
import { KeyHint } from "./key-hint";

/** Row actions show on hover or focus. A touch screen has no hover, so they always show there. */
const ROW_ACTIONS = cn(
  "flex shrink-0 items-center gap-0.5",
  "opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
  "group-focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100",
);

/**
 * Queued messages (#489), tucked behind the top of the composer, FIFO. Each row can be steered
 * (#490: stop the reply and send it now), edited in place, or removed. The flush waits while the
 * next row is open for an edit, so a half-edited message never sends.
 */
export function QueueTray({
  items,
  isStreaming,
  canSteer,
  steeringId,
  sendingHead,
  editingId,
  onEditingChange,
  onUpdate,
  onRemove,
  onSendNow,
}: {
  items: QueuedMessage[];
  isStreaming: boolean;
  /** A reply can stop for a steer, so "send now" reads "Steer". */
  canSteer: boolean;
  /** The row that a steer stopped the reply for. It sends when the stop lands. */
  steeringId?: string | null | undefined;
  /** The flush is sending the first row now. */
  sendingHead?: boolean | undefined;
  editingId?: string | null | undefined;
  onEditingChange?: ((id: string | null) => void) | undefined;
  onUpdate?: ((id: string, text: string) => void) | undefined;
  onRemove: (id: string) => void;
  /** Absent while no steer can run, e.g. while an approval waits. */
  onSendNow?: ((id: string) => void) | undefined;
}) {
  const [listRef] = useAutoAnimate<HTMLOListElement>();

  if (items.length === 0) return null;
  const headEditing = items[0]?.id === editingId;

  const status = headEditing
    ? "Waits for your edit"
    : isStreaming
      ? "Sends when the reply ends"
      : null;

  return (
    <section
      aria-label="Queued messages"
      className={cn(
        // Tucked: the composer overlaps the bottom edge, so the tray reads as one stack with it.
        "relative z-0 mx-3 -mb-5 rounded-t-[20px] border border-b-0 border-app-fg-a1/30 pb-5",
        "bg-app-bg-2/90 shadow-[0_-1px_12px_rgba(0,0,0,0.04)] backdrop-blur-md",
        "app-card-in",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1">
        <span className="text-[11px] font-medium tracking-tight text-app-fg-3">
          Queued
          <span className="tabular ml-1.5 text-app-fg-2">{items.length}</span>
        </span>
        {status ? <span className="text-[11px] text-app-fg-2">{status}</span> : null}
      </header>
      <ol ref={listRef} className="flex flex-col gap-px px-1.5 pb-1.5">
        {items.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            index={index}
            state={
              item.id === steeringId
                ? "steering"
                : index === 0 && sendingHead
                  ? "sending"
                  : item.id === editingId
                    ? "editing"
                    : "idle"
            }
            canSteer={canSteer}
            onEdit={onUpdate && onEditingChange ? () => onEditingChange(item.id) : undefined}
            onEditEnd={() => onEditingChange?.(null)}
            onSave={(text) => {
              onEditingChange?.(null);

              // An emptied message with nothing else to send leaves the queue.
              if (!text.trim() && item.files.length === 0) onRemove(item.id);
              else onUpdate?.(item.id, replaceQuotedBody(item.text, text.trim()));
            }}
            onRemove={() => onRemove(item.id)}
            onSendNow={onSendNow ? () => onSendNow(item.id) : undefined}
          />
        ))}
      </ol>
    </section>
  );
}

type RowState = "idle" | "editing" | "steering" | "sending";

function QueueRow({
  item,
  index,
  state,
  canSteer,
  onEdit,
  onEditEnd,
  onSave,
  onRemove,
  onSendNow,
}: {
  item: QueuedMessage;
  index: number;
  state: RowState;
  /** A reply streams, so "send now" stops it first. */
  canSteer: boolean;
  onEdit?: (() => void) | undefined;
  onEditEnd: () => void;
  onSave: (text: string) => void;
  onRemove: () => void;
  onSendNow?: (() => void) | undefined;
}) {
  const { quote, body } = splitQuote(item.text);
  const textRef = useRef<HTMLButtonElement | null>(null);

  const fileHint =
    item.files.length > 0 ? `${item.files.length} file${item.files.length > 1 ? "s" : ""}` : null;

  const sendNowLabel = canSteer ? "Steer" : "Send now";
  const busy = state === "steering" || state === "sending";

  // Give focus back to the row after an edit, so the keyboard user keeps their place.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && state !== "editing" && document.activeElement === document.body)
      textRef.current?.focus();

    wasEditing.current = state === "editing";
  }, [state]);

  if (state === "editing")
    return (
      <li>
        <QueueEditor
          initial={body}
          quote={quote}
          sendNowLabel={onSendNow ? sendNowLabel : null}
          onCancel={onEditEnd}
          onSave={onSave}
          onSaveAndSend={(text) => {
            onSave(text);
            onSendNow?.();
          }}
        />
      </li>
    );

  return (
    <li
      className={cn(
        "group flex min-h-9 items-center gap-2.5 rounded-xl py-1 pr-1 pl-2.5",
        "transition-colors duration-150 focus-within:bg-app-bg-a2 hover:bg-app-bg-a2",
        busy && "bg-app-purple-1/40 hover:bg-app-purple-1/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "tabular inline-flex size-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
          busy ? "bg-app-purple-4 text-white" : "bg-app-bg-a2 text-app-fg-3",
        )}
      >
        {busy ? <ArrowUp size={10} strokeWidth={2.75} /> : index + 1}
      </span>
      <button
        ref={textRef}
        type="button"
        disabled={!onEdit || busy}
        onClick={onEdit}
        aria-label={onEdit ? `Edit queued message: ${body || fileHint || "attachment"}` : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] leading-snug text-app-fg-4",
          "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2/60",
          onEdit && !busy && "cursor-text",
        )}
      >
        {quote ? (
          <CornerDownRight size={12} aria-hidden className="shrink-0 text-app-fg-2" />
        ) : null}
        <span className="min-w-0 truncate">{body || fileHint || "Attachment"}</span>
        {body && fileHint ? (
          <span className="shrink-0 text-[12px] text-app-fg-2">· {fileHint}</span>
        ) : null}
      </button>
      {busy ? (
        <span className="animate-chat-shimmer shrink-0 pr-2 text-[12px] font-medium text-app-purple-4">
          {state === "steering" ? "Steering…" : "Sending…"}
        </span>
      ) : (
        <div className={ROW_ACTIONS}>
          {onSendNow ? (
            <Tip
              label={sendNowLabel}
              description={canSteer ? "Stops the reply and sends this now." : "Sends this next."}
            >
              <button
                type="button"
                aria-label={`${sendNowLabel}: ${body || fileHint || "attachment"}`}
                onClick={onSendNow}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium",
                  "app-press bg-app-purple-1 text-app-purple-4 transition-colors hover:bg-app-purple-2/50",
                  "app-focus",
                )}
              >
                <ArrowUp size={12} strokeWidth={2.5} />
                {sendNowLabel}
              </button>
            </Tip>
          ) : null}
          {onEdit ? (
            <RowIcon label="Edit" onClick={onEdit}>
              <Pencil size={12} />
            </RowIcon>
          ) : null}
          <RowIcon label="Remove" onClick={onRemove}>
            <X size={13} />
          </RowIcon>
        </div>
      )}
    </li>
  );
}

function RowIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-full",
          "app-press text-app-fg-3 transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
          "app-focus",
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

/** In-place editor for one queued message. ↵ saves, ⌘↵ saves and sends now, Esc cancels. */
function QueueEditor({
  initial,
  quote,
  sendNowLabel,
  onCancel,
  onSave,
  onSaveAndSend,
}: {
  initial: string;
  quote: string | null;
  /** `null` when this row cannot send now. */
  sendNowLabel: string | null;
  onCancel: () => void;
  onSave: (text: string) => void;
  onSaveAndSend: (text: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;

    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Escape") {
      // Keep the Escape here, so it does not also close other chat overlays.
      e.stopPropagation();
      onCancel();

      return;
    }

    if (e.key !== "Enter" || e.shiftKey) return;

    if ((e.metaKey || e.ctrlKey) && sendNowLabel) {
      e.preventDefault();
      onSaveAndSend(value);

      return;
    }

    // Touch: Enter adds a line, as in the composer. The Save button commits.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    e.preventDefault();
    onSave(value);
  };

  return (
    <div className="app-fade-in rounded-xl bg-app-bg-1 p-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-app-fg-a1/40">
      {quote ? (
        <p className="mb-1.5 flex items-start gap-1.5 px-1 text-[12px] leading-snug text-app-fg-2">
          <CornerDownRight size={12} aria-hidden className="mt-0.5 shrink-0" />
          <span className="line-clamp-1">{quote}</span>
        </p>
      ) : null}
      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label="Edit queued message"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          "block field-sizing-content max-h-40 min-h-6 w-full resize-none bg-transparent px-1",
          "text-[13px] leading-relaxed text-app-fg-4 outline-none placeholder:text-app-fg-2",
        )}
        placeholder="Clear it to remove it from the queue"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 text-[11px] text-app-fg-2 [@media(pointer:coarse)]:invisible">
          <KeyHint keys="↵">Save</KeyHint>
          {sendNowLabel ? <KeyHint keys="⌘↵">{sendNowLabel}</KeyHint> : null}
          <KeyHint keys="esc">Cancel</KeyHint>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="app-press app-focus h-6 rounded-full px-2.5 text-[12px] font-medium text-app-fg-3 hover:bg-app-bg-a2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(value)}
            className="app-press app-focus h-6 rounded-full bg-app-fg-4 px-2.5 text-[12px] font-medium text-app-bg-1 hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
