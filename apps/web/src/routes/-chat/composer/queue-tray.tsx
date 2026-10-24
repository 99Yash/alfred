import { ArrowUp, CornerDownRight, ListEnd, Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { QueuedMessage } from "~/lib/chat/use-chat-queue";
import { CollapseItem, CollapseList } from "../collapse-list";
import { splitQuote } from "../quote";
import { Tip } from "../tip";

/** A quiet text-and-icon button for the tray. Muted at rest, full ink on hover. */
const GHOST_BUTTON = cn(
  "app-press app-focus inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2",
  "text-[12px] font-medium text-app-fg-3 transition-colors duration-150",
  "hover:bg-app-bg-a2 hover:text-app-fg-4",
);

/**
 * Queued messages (#489), tucked behind the top of the composer, FIFO. Each row can be steered
 * (#490: stop the reply and send it now), edited, or removed. An edit loads the row into the
 * composer below. The flush waits while the next row is in an edit, so a half-edited message
 * never sends. A Stop pauses the queue until Resume.
 */
export function QueueTray({
  items,
  isStreaming,
  canSteer,
  steeringId,
  sendingId,
  editingId,
  paused,
  onResume,
  onEdit,
  onRemove,
  onSendNow,
}: {
  items: QueuedMessage[];
  isStreaming: boolean;
  /** A reply can stop for a steer, so "send now" reads "Steer". */
  canSteer: boolean;
  /** The row that a steer stopped the reply for. It sends when the stop lands. */
  steeringId?: string | null | undefined;
  /** The row with a send in flight, at any position. It cannot change until the send settles. */
  sendingId?: string | null | undefined;
  editingId?: string | null | undefined;
  /** Stop held the queue. Nothing sends until Resume. */
  paused?: boolean | undefined;
  onResume?: (() => void) | undefined;
  /** Load this row into the composer. Absent while the composer cannot take an edit. */
  onEdit?: ((id: string) => void) | undefined;
  onRemove: (id: string) => void;
  /** Absent while no steer can run, e.g. while an approval waits. */
  onSendNow?: ((id: string) => void) | undefined;
}) {
  if (items.length === 0) return null;
  const headEditing = items[0]?.id === editingId;
  const count = `${items.length} queued message${items.length > 1 ? "s" : ""}`;

  // The rows show the queue. Only a screen reader needs to hear when it sends.
  const status = paused
    ? `${count}. Paused.`
    : headEditing
      ? `${count}. Waits for your edit.`
      : isStreaming
        ? `${count}. Sends when the reply ends.`
        : count;

  return (
    <section
      aria-label="Queued messages"
      className={cn(
        // Tucked: the composer overlaps the bottom edge, so the tray reads as one stack with it.
        "relative z-0 mx-3 -mb-5 rounded-t-panel border border-b-0 border-app-fg-a1/30 pb-5",
        "bg-app-bg-2/90 shadow-[0_-1px_12px_rgba(0,0,0,0.04)] backdrop-blur-md",
        "app-card-in",
      )}
    >
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      {paused ? (
        <header className="app-fade-in flex min-h-10 items-center justify-between gap-2 border-b border-app-fg-a1/20 pr-2 pl-4">
          <span className="flex min-w-0 items-center gap-2 text-[12px] text-app-fg-3">
            <Pause size={11} aria-hidden className="shrink-0 fill-current text-app-fg-2" />
            <span className="truncate">Queue paused because you stopped the reply</span>
          </span>
          {onResume ? (
            <button type="button" onClick={onResume} className={GHOST_BUTTON}>
              <Play size={10} aria-hidden className="fill-current" />
              Resume
            </button>
          ) : null}
        </header>
      ) : null}
      <CollapseList as="ol" className="flex flex-col gap-px p-1.5">
        {items.map((item) => (
          <CollapseItem key={item.id}>
            <QueueRow
              item={item}
              state={
                item.id === steeringId
                  ? "steering"
                  : item.id === sendingId
                    ? "sending"
                    : item.id === editingId
                      ? "editing"
                      : "idle"
              }
              canSteer={canSteer}
              onEdit={onEdit ? () => onEdit(item.id) : undefined}
              onRemove={() => onRemove(item.id)}
              onSendNow={onSendNow ? () => onSendNow(item.id) : undefined}
            />
          </CollapseItem>
        ))}
      </CollapseList>
    </section>
  );
}

type RowState = "idle" | "editing" | "steering" | "sending";

function QueueRow({
  item,
  state,
  canSteer,
  onEdit,
  onRemove,
  onSendNow,
}: {
  item: QueuedMessage;
  state: RowState;
  /** A reply streams, so "send now" stops it first. */
  canSteer: boolean;
  onEdit?: (() => void) | undefined;
  onRemove: () => void;
  onSendNow?: (() => void) | undefined;
}) {
  const { quote, body } = splitQuote(item.text);

  // A retry carries stored attachments by id, not as files.
  const fileCount = item.files.length + (item.retryAttachmentIds?.length ?? 0);
  const fileHint = fileCount > 0 ? `${fileCount} file${fileCount > 1 ? "s" : ""}` : null;

  const sendNowLabel = canSteer ? "Steer" : "Send now";
  const busy = state === "steering" || state === "sending";
  const editing = state === "editing";

  return (
    <div
      className={cn(
        "group flex min-h-10 items-center gap-2.5 rounded-surface py-1 pr-1 pl-2.5",
        "transition-colors duration-150 focus-within:bg-app-bg-a2 hover:bg-app-bg-a2",
        (busy || editing) && "bg-app-purple-1/40 hover:bg-app-purple-1/40",
      )}
    >
      {busy ? (
        <ArrowUp size={14} strokeWidth={2.25} aria-hidden className="shrink-0 text-app-purple-4" />
      ) : editing ? (
        <Pencil size={13} aria-hidden className="shrink-0 text-app-purple-4" />
      ) : (
        <ListEnd size={14} aria-hidden className="shrink-0 text-app-fg-2" />
      )}
      <button
        type="button"
        disabled={!onEdit || busy || editing}
        onClick={onEdit}
        aria-label={onEdit ? `Edit queued message: ${body || fileHint || "attachment"}` : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] leading-snug text-app-fg-4",
          "rounded-control-sm outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2/60",
          onEdit && !busy && !editing && "cursor-text",
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
      ) : editing ? (
        <span className="shrink-0 pr-2 text-[12px] font-medium text-app-purple-4">
          Editing below
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          {onSendNow ? (
            <Tip
              label={sendNowLabel}
              description={canSteer ? "Stops the reply and sends this now." : "Sends this next."}
            >
              <button
                type="button"
                aria-label={`${sendNowLabel}: ${body || fileHint || "attachment"}`}
                onClick={onSendNow}
                className={GHOST_BUTTON}
              >
                <CornerDownRight size={12} aria-hidden />
                {sendNowLabel}
              </button>
            </Tip>
          ) : null}
          {onEdit ? (
            <RowIcon label="Edit" onClick={onEdit}>
              <Pencil size={13} />
            </RowIcon>
          ) : null}
          <RowIcon label="Remove" onClick={onRemove}>
            <Trash2 size={13} />
          </RowIcon>
        </div>
      )}
    </div>
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
          "inline-flex size-7 items-center justify-center rounded-full",
          "app-press text-app-fg-2 transition-colors duration-150 hover:bg-app-bg-a2 hover:text-app-fg-4",
          "app-focus",
        )}
      >
        {children}
      </button>
    </Tip>
  );
}
