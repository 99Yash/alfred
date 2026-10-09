import type { ChatErrorKind } from "@alfred/contracts";
import type { SyncedChatAttachment, SyncedChatMessage } from "@alfred/sync";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { altTextImageComponents, MarkdownPre } from "~/components/markdown-renderer";
import { animateWords } from "~/lib/chat/animate-text";
import { cn } from "~/lib/utils";
import { ConnectNudgeRows } from "./connect-nudge-rows";
import { useMarkdownImageMode } from "./published-transcript";
import { splitPersistedToolCalls } from "./connect-nudges";
import { ReasoningSection } from "./reasoning-section";
import { SourcesStrip } from "./sources-strip";
import { collectSources } from "./sources";
import { ToolCallGroup } from "./tool-call-group";
import { WorkflowRecoveryCta } from "./workflow-recovery-cta";
import { UsageLine } from "./usage-line";
import { API_URL } from "~/lib/eden";

const MARKDOWN_CLASSES = cn(
  "[&_p]:leading-relaxed [&_p]:tracking-tight [&>*+*]:mt-6",
  "[&_a]:text-app-purple-4 [&_a]:underline [&_a]:underline-offset-2",
  "[&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
  // Inline code only; fenced blocks render through `MarkdownPre`.
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-app-bg-2 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em]",
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-app-fg-a1 [&_blockquote]:pl-3 [&_blockquote]:text-app-fg-3 [&_strong]:font-semibold",
  // GFM tables: the table scrolls inside the bubble, with row dividers and tabular figures.
  "[&_table]:block [&_table]:w-fit [&_table]:max-w-full [&_table]:overflow-x-auto",
  "[&_table]:border-collapse [&_table]:text-[13px] [&_table]:tabular-nums",
  "[&_thead_th]:border-b [&_thead_th]:border-app-fg-a3",
  "[&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-app-fg-4",
  "[&_td]:px-3 [&_td]:py-1.5 [&_td]:text-left [&_td]:align-top",
  "[&_tbody_tr]:border-b [&_tbody_tr]:border-app-fg-a1 [&_tbody_tr:last-child]:border-b-0",
  "[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-app-bg-2/60",
);

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * Failed-turn copy by {@link ChatErrorKind}. The server sends a tag, never raw provider errors.
 * `retry: "none"` hides Retry when retrying cannot help.
 */
const FAILURE_PRESENTATION = {
  attachment: {
    message: "I couldn't read one of the attached files. I can try again with just your message.",
    retry: "without_attachments",
  },
  attachment_history: {
    message:
      "I couldn't read an image from earlier in this thread, and it'll keep affecting replies here. Start a new chat to continue.",
    retry: "none",
  },
  budget_exhausted: {
    message:
      "My model budget is used up, so I can't reply right now. Top it up, then send your message again.",
    retry: "none",
  },
  overloaded: { message: "I hit a brief glitch on my end.", retry: "same" },
  rate_limited: {
    message: "I'm getting a lot of requests right now. Give it a moment, then try again.",
    retry: "same",
  },
  timeout: {
    message: "That one ran long and I had to stop before finishing. Try again.",
    retry: "same",
  },
  too_long: {
    message: "This conversation got too long for me to continue. Start a new chat to keep going.",
    retry: "none",
  },
  generic: { message: "Something interrupted this reply.", retry: "same" },
} satisfies Record<
  ChatErrorKind,
  { message: string; retry: "same" | "without_attachments" | "none" }
>;

/** Failed rows saved before `errorKind` existed. */
const LEGACY_FAILURE = { message: "This reply didn't finish.", retry: "same" } as const;

const FAILURE_ACTION_CLASS = cn(
  "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium",
  "text-app-fg-3 hover:bg-app-red-2 hover:text-app-fg-4",
  "transition-[background-color,color] duration-150",
  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
  "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
);

/** Fenced code uses the shared `CodeBlock`. Inline code gets the wrapper's chip style. */
const BASE_COMPONENTS: Components = { pre: MarkdownPre };

/** Streaming: each word fades up out of a blur. */
const STREAMING_COMPONENTS: Components = {
  ...BASE_COMPONENTS,
  p: ({ children }) => <p>{animateWords(children)}</p>,
  li: ({ children }) => <li>{animateWords(children)}</li>,
};

/** A delimiter row (`|---|:--:|`), maybe half-typed. */
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*$/;

/**
 * While streaming, hide a trailing table until its first data row starts.
 * Before the delimiter row is complete, remark-gfm shows the header as raw pipes.
 */
function hideIncompleteTableTail(text: string): string {
  // Skip the O(n) split per token unless the last non-blank line has a pipe.
  let last = text.length - 1;

  while (last >= 0 && /\s/.test(text[last]!)) last--;

  if (last < 0) return text; // all blank
  const lastLineStart = text.lastIndexOf("\n", last) + 1;

  if (!text.slice(lastLineStart, last + 1).includes("|")) return text;

  const lines = text.split("\n");
  // A header that just got its newline is still a fragment.
  let end = lines.length - 1;

  while (end >= 0 && lines[end]?.trim() === "") end--;

  if (end < 0) return text;
  let start = end + 1;

  for (let i = end; i >= 0; i--) {
    if (lines[i]?.includes("|")) start = i;
    else break;
  }

  if (start > end) return text; // no trailing pipe lines
  const block = lines.slice(start, end + 1);

  // Prose with an inline `|` does not start the line with a pipe.
  if (!/^\s*\|/.test(block[0] ?? "")) return text;
  const dataRowStarted = block.length > 2 && TABLE_DELIMITER.test(block[1] ?? "");

  if (dataRowStarted) return text; // valid table

  return lines.slice(0, start).join("\n"); // hold back the header
}

/**
 * Stop half-typed markdown from showing raw markers while streaming.
 * `remend` closes open inline tokens and shows a half-typed link as text.
 * `katex` is off because this path has no math plugin. The final body is not touched.
 */
function healStreamingMarkdown(text: string): string {
  return remend(hideIncompleteTableTail(text), { linkMode: "text-only", katex: false });
}

/** Assistant markdown, with a caret and per-word reveal while streaming. */
export function AssistantMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const body = streaming ? healStreamingMarkdown(text) : text;

  // No `MarkdownRenderer` here, so merge its image override by hand. Keep it last so no remote `<img>` returns.
  const imageComponents =
    useMarkdownImageMode() === "alt-text" ? altTextImageComponents("surface") : null;

  const baseComponents = streaming ? STREAMING_COMPONENTS : BASE_COMPONENTS;

  return (
    <div
      // Reply code stays 13px; the shared CodeBlock defaults to 11.5px.
      // SAFETY: CSSProperties has no type for custom properties.
      style={{ "--md-code-fs": "13px" } as React.CSSProperties}
      className={cn("text-sm leading-relaxed tracking-tight text-app-fg-4", MARKDOWN_CLASSES)}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={imageComponents ? { ...baseComponents, ...imageComponents } : baseComponents}
      >
        {body}
      </ReactMarkdown>
      {streaming ? (
        <span className="animate-chat-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-app-fg-3 align-middle" />
      ) : null}
    </div>
  );
}

/** Image attachments (ADR-0065) through the auth-gated proxy, with placeholders for pending or failed. */
function MessageAttachments({ attachments }: { attachments: SyncedChatAttachment[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-2">
      {attachments.map((a) => (
        <MessageAttachment key={a.id} attachment={a} />
      ))}
    </div>
  );
}

function AttachmentPlaceholder({ label, onRetry }: { label: string; onRetry?: () => void }) {
  const className =
    "grid size-40 place-items-center rounded-xl border border-app-fg-a1/30 bg-app-bg-2 px-2 text-center text-xs text-app-fg-3";

  if (onRetry) {
    return (
      <button type="button" onClick={onRetry} className={`${className} hover:bg-app-bg-3`}>
        {label}
      </button>
    );
  }

  return <div className={className}>{label}</div>;
}

function MessageAttachment({ attachment }: { attachment: SyncedChatAttachment }) {
  // Bump to remount the <img> and refetch after a load failure.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  if (attachment.status !== "ready") {
    return (
      <AttachmentPlaceholder
        label={attachment.status === "failed" ? "Couldn't process" : "Processing…"}
      />
    );
  }

  if (loadFailed) {
    return (
      <AttachmentPlaceholder
        label="Couldn't load. Tap to retry."
        onRetry={() => {
          setLoadFailed(false);
          setLoadAttempt((n) => n + 1);
        }}
      />
    );
  }

  const url = `${API_URL}/api/chat/attachments/${attachment.id}/content`;

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="block size-40 overflow-hidden rounded-xl border border-app-fg-a1/30 bg-app-bg-2"
    >
      <img
        key={loadAttempt}
        src={url}
        alt={attachment.name}
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
        onError={() => setLoadFailed(true)}
      />
    </a>
  );
}

/** A synced user or assistant message. */
export function MessageBubble({
  message,
  attachments,
  onRetry,
  onRetryWithoutAttachments,
}: {
  message: SyncedChatMessage;
  attachments?: SyncedChatAttachment[] | undefined;
  /** On a failed reply: re-send the user turn behind it. */
  onRetry?: (() => void) | undefined;
  /** When dropping attachments can recover the failed turn. */
  onRetryWithoutAttachments?: (() => void) | undefined;
}) {
  // For the copy button's text/html. Declared before the role branch, as hooks must be.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {attachments && attachments.length > 0 ? (
          <MessageAttachments attachments={attachments} />
        ) : null}
        {message.content.length > 0 ? (
          <div className="max-w-[80%] rounded-2xl bg-app-bg-2 px-4 py-2.5 text-sm leading-relaxed tracking-tight whitespace-pre-wrap text-app-fg-4">
            {message.content}
          </div>
        ) : null}
      </div>
    );
  }

  // Connection bounces are repair offers, not cards (#378 item 3).
  const { cards: tools, nudges } = splitPersistedToolCalls(message.toolCalls ?? []);
  const sources = collectSources(tools);
  const failed = message.status === "failed";

  const failure = failed
    ? message.errorKind
      ? FAILURE_PRESENTATION[message.errorKind]
      : LEGACY_FAILURE
    : null;

  const failureMessage =
    failure?.retry === "without_attachments" && !onRetryWithoutAttachments
      ? "I couldn't read the attached file. Start a new chat with a different file, or send a text message instead."
      : failure?.message;

  return (
    <div className="group/message flex flex-col gap-2">
      {message.reasoning && message.reasoning.trim().length > 0 ? (
        <ReasoningSection
          reasoning={message.reasoning}
          active={false}
          durationMs={message.reasoningMs}
        />
      ) : null}
      {/* No `tools.length` gate: an all-bounced turn still has prose. */}
      <ToolCallGroup tools={tools} narration={message.narration ?? []} active={false} />
      <WorkflowRecoveryCta tools={tools} />
      {message.content.length > 0 ? (
        <div ref={bodyRef}>
          <AssistantMarkdown text={message.content} />
        </div>
      ) : null}
      <ConnectNudgeRows nudges={nudges} />
      {sources.length > 0 ? <SourcesStrip sources={sources} /> : null}
      {failure ? (
        <div
          role="alert"
          className={cn(
            "inline-flex w-fit max-w-[80%] flex-wrap items-center gap-x-3 gap-y-1.5",
            "rounded-xl bg-app-red-1 px-3 py-2",
          )}
        >
          <p className="text-[13px] leading-snug text-app-red-4">{failureMessage}</p>
          {failure.retry === "same" && onRetry ? (
            <button type="button" onClick={onRetry} className={FAILURE_ACTION_CLASS}>
              <RotateCcw size={13} />
              Retry
            </button>
          ) : failure.retry === "without_attachments" && onRetryWithoutAttachments ? (
            <button
              type="button"
              onClick={onRetryWithoutAttachments}
              className={FAILURE_ACTION_CLASS}
            >
              <RotateCcw size={13} />
              Send without it
            </button>
          ) : null}
        </div>
      ) : null}
      {message.content.length > 0 ? (
        <CopyMessageButton content={message.content} htmlRef={bodyRef} />
      ) : null}
      {message.usage ? <UsageLine usage={message.usage} tone={failed ? "failed" : "ok"} /> : null}
    </div>
  );
}

/** Copy the reply as text/html (pastes keep formatting) and markdown, or markdown alone without ClipboardItem. */
export function CopyMessageButton({
  content,
  htmlRef,
}: {
  content: string;
  htmlRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const onCopy = () => {
    if (copied) return;
    const html = htmlRef.current?.innerHTML;

    const write =
      html && typeof ClipboardItem !== "undefined"
        ? navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([content], { type: "text/plain" }),
            }),
          ])
        : navigator.clipboard.writeText(content);

    write.then(
      () => {
        setCopied(true);

        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard write can fail; stay quiet.
      },
    );
  };

  return (
    <div
      className={cn(
        "-ml-1.5 flex items-center",
        "opacity-0 transition-opacity duration-150",
        "group-hover/message:opacity-100 focus-within:opacity-100",
      )}
    >
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy message"}
        title={copied ? "Copied" : "Copy message"}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-lg",
          "text-app-fg-2 hover:bg-app-bg-2 hover:text-app-fg-4",
          "transition-[background-color,color] duration-150",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        )}
      >
        {copied ? <Check size={13} className="text-app-green-4" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
