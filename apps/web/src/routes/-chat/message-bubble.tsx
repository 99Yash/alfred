import type { ChatErrorKind } from "@alfred/contracts";
import type { SyncedChatAttachment, SyncedChatMessage } from "@alfred/sync";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { animateWords } from "~/lib/chat/animate-text";
import { cn } from "~/lib/utils";
import { CodeBlock, InlineCode } from "./code-block";
import { ReasoningSection } from "./reasoning-section";
import { SourcesStrip } from "./sources-strip";
import { collectSources } from "./sources";
import { ToolCallGroup } from "./tool-call-group";

const MARKDOWN_CLASSES = cn(
  // Match the blog body rhythm: 24px between blocks, tight tracking, relaxed leading.
  "[&>*+*]:mt-6 [&_p]:tracking-tight [&_p]:leading-relaxed",
  "[&_a]:text-app-purple-4 [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-app-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]",
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold",
  "[&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-app-fg-a1 [&_blockquote]:pl-3 [&_blockquote]:text-app-fg-3",
);

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * Failed-turn copy, keyed off the server's {@link ChatErrorKind}. The server
 * never sends raw provider errors (they leak vendor URLs); it sends a tag and
 * the bubble owns the wording + whether a plain retry can help. First-person,
 * short declaratives (Alfred is the one speaking). `retryable:false` hides the
 * Retry button where re-sending the identical turn would just fail again (a
 * file the model can't read, a conversation past the length cap).
 */
const FAILURE_PRESENTATION: Record<ChatErrorKind, { message: string; retryable: boolean }> = {
  attachment: {
    message:
      "I couldn't read one of the attached files. It may be corrupted or an unsupported type. Try a different one.",
    retryable: false,
  },
  overloaded: { message: "I hit a brief glitch on my end.", retryable: true },
  rate_limited: {
    message: "I'm getting a lot of requests right now. Give it a moment, then try again.",
    retryable: true,
  },
  too_long: {
    message: "This conversation got too long for me to continue. Start a new chat to keep going.",
    retryable: false,
  },
  generic: { message: "Something interrupted this reply.", retryable: true },
};

/** Fallback for legacy failed rows persisted before `errorKind` existed. */
const LEGACY_FAILURE = { message: "This reply didn't finish.", retryable: true } as const;

/** Fenced code → highlighted card; inline code keeps the markdown chip styling. */
const BASE_COMPONENTS: Components = { pre: CodeBlock, code: InlineCode };

/** Streaming variant: each word in a paragraph / list item fades up out of a blur. */
const STREAMING_COMPONENTS: Components = {
  ...BASE_COMPONENTS,
  p: ({ children }) => <p>{animateWords(children)}</p>,
  li: ({ children }) => <li>{animateWords(children)}</li>,
};

/** Assistant markdown body, with a blinking caret + per-word reveal while streaming. */
export function AssistantMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn("text-sm leading-relaxed tracking-tight text-app-fg-4", MARKDOWN_CLASSES)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={streaming ? STREAMING_COMPONENTS : BASE_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
      {streaming ? (
        <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-chat-caret bg-app-fg-3 align-middle" />
      ) : null}
    </div>
  );
}

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * Image attachments on a user message (ADR-0065). The bytes load from the
 * auth-gated content proxy (the bucket is private); `ready` images render, while
 * `pending` / `failed` rows show a lightweight placeholder rather than a broken
 * image. Phase 1 is images only.
 */
function MessageAttachments({ attachments }: { attachments: SyncedChatAttachment[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-2">
      {attachments.map((a) =>
        a.status === "ready" ? (
          <a
            key={a.id}
            href={`${API_URL}/api/chat/attachments/${a.id}/content`}
            target="_blank"
            rel="noreferrer"
            className="block h-40 w-40 overflow-hidden rounded-xl border border-app-fg-a1/30 bg-app-bg-2"
          >
            <img
              src={`${API_URL}/api/chat/attachments/${a.id}/content`}
              alt={a.name}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </a>
        ) : (
          <div
            key={a.id}
            className="grid h-40 w-40 place-items-center rounded-xl border border-app-fg-a1/30 bg-app-bg-2 px-2 text-center text-xs text-app-fg-3"
          >
            {a.status === "failed" ? "Couldn't process" : "Processing…"}
          </div>
        ),
      )}
    </div>
  );
}

/** A persisted message (user or assistant) from the synced store. */
export function MessageBubble({
  message,
  attachments,
  onRetry,
}: {
  message: SyncedChatMessage;
  /** Image attachments on this (user) message, from the synced store. */
  attachments?: SyncedChatAttachment[];
  /** Present on a failed assistant reply — re-sends the user turn behind it. */
  onRetry?: () => void;
}) {
  // Rendered-markdown container; CopyMessageButton lifts its innerHTML for
  // the rich (text/html) clipboard flavor. Unconditional — hooks can't sit
  // behind the user/assistant branch.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {attachments && attachments.length > 0 ? (
          <MessageAttachments attachments={attachments} />
        ) : null}
        {message.content.length > 0 ? (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-app-bg-2 px-4 py-2.5 text-sm leading-relaxed tracking-tight text-app-fg-4">
            {message.content}
          </div>
        ) : null}
      </div>
    );
  }
  const tools = message.toolCalls ?? [];
  const sources = collectSources(tools);
  const failed = message.status === "failed";
  const failure = failed
    ? message.errorKind
      ? FAILURE_PRESENTATION[message.errorKind]
      : LEGACY_FAILURE
    : null;
  return (
    <div className="group/message flex flex-col gap-2">
      {message.reasoning && message.reasoning.trim().length > 0 ? (
        <ReasoningSection
          reasoning={message.reasoning}
          active={false}
          durationMs={message.reasoningMs}
        />
      ) : null}
      {tools.length > 0 ? (
        <ToolCallGroup tools={tools} narration={message.narration ?? undefined} active={false} />
      ) : null}
      {message.content.length > 0 ? (
        <div ref={bodyRef}>
          <AssistantMarkdown text={message.content} />
        </div>
      ) : null}
      {sources.length > 0 ? <SourcesStrip sources={sources} /> : null}
      {failure ? (
        <div className="flex items-center gap-2.5" role="alert">
          <p className="text-[13px] text-app-red-4">{failure.message}</p>
          {onRetry && failure.retryable ? (
            <button
              type="button"
              onClick={onRetry}
              className={cn(
                "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium",
                "text-app-fg-3 hover:bg-app-bg-2 hover:text-app-fg-4",
                "transition-[background-color,color] duration-150",
                "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
              )}
            >
              <RotateCcw size={13} />
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {message.content.length > 0 ? (
        <CopyMessageButton content={message.content} htmlRef={bodyRef} />
      ) : null}
    </div>
  );
}

/**
 * Hover action under an assistant reply: copy the message. Writes both
 * `text/html` (the rendered markup, so pastes into Gmail / Docs keep lists,
 * links and headings) and `text/plain` (the raw markdown) when ClipboardItem
 * is available; falls back to plain markdown otherwise. Hidden until the
 * message is hovered (or the button itself is focused) so the transcript
 * stays quiet; the copied state holds the check for a beat as feedback.
 */
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
        // Clipboard write can fail (permissions, insecure context); stay quiet.
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
          "text-app-fg-2 hover:text-app-fg-4 hover:bg-app-bg-2",
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
