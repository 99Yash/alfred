import type { ChatErrorKind } from "@alfred/contracts";
import type { SyncedChatAttachment, SyncedChatMessage } from "@alfred/sync";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { MarkdownPre } from "~/components/markdown-renderer";
import { animateWords } from "~/lib/chat/animate-text";
import { cn } from "~/lib/utils";
import { ReasoningSection } from "./reasoning-section";
import { SourcesStrip } from "./sources-strip";
import { collectSources } from "./sources";
import { ToolCallGroup } from "./tool-call-group";

const MARKDOWN_CLASSES = cn(
  // Match the blog body rhythm: 24px between blocks, tight tracking, relaxed leading.
  "[&_p]:leading-relaxed [&_p]:tracking-tight [&>*+*]:mt-6",
  "[&_a]:text-app-purple-4 [&_a]:underline [&_a]:underline-offset-2",
  "[&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
  // Inline code only — scope to `:not(pre)>code` so this chip styling never
  // bleeds onto the `<code>` inside a fenced CodeBlock (which owns its own
  // dark-card chrome). Fenced blocks render through `MarkdownPre` below.
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-app-bg-2 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em]",
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-app-fg-a1 [&_blockquote]:pl-3 [&_blockquote]:text-app-fg-3 [&_strong]:font-semibold",
  // Tables — GFM tables (remark-gfm). The browser default renders these as
  // borderless, padding-less text columns ("#289" collides with the next
  // cell). Dress them as a real data table: the table is its own horizontal
  // scroller (display:block + w-fit) so a wide table scrolls inside the bubble
  // instead of blowing it open, with clean horizontal dividers — a stronger
  // rule under the header, hairlines between rows — rather than a heavy full
  // grid. Padded cells, top-aligned, tabular figures so numeric columns line up.
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
 * Failed-turn copy, keyed off the server's {@link ChatErrorKind}. The server
 * never sends raw provider errors (they leak vendor URLs); it sends a tag and
 * the bubble owns the wording + whether a plain retry can help. First-person,
 * short declaratives (Alfred is the one speaking). `retry:"none"` hides the
 * Retry button where there is no useful automatic recovery (for example, a
 * conversation past the length cap).
 */
const FAILURE_PRESENTATION: Record<
  ChatErrorKind,
  { message: string; retry: "same" | "without_attachments" | "none" }
> = {
  attachment: {
    message: "I couldn't read one of the attached files. I can try again with just your message.",
    retry: "without_attachments",
  },
  attachment_history: {
    message:
      "I couldn't read an image from earlier in this thread, and it'll keep affecting replies here. Start a new chat to continue.",
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
};

/** Fallback for legacy failed rows persisted before `errorKind` existed. */
const LEGACY_FAILURE = { message: "This reply didn't finish.", retry: "same" } as const;

/** Shared styling for the retry action inside a failed-turn notice. */
const FAILURE_ACTION_CLASS = cn(
  "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium",
  "text-app-fg-3 hover:bg-app-red-2 hover:text-app-fg-4",
  "transition-[background-color,color] duration-150",
  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
  "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
);

/**
 * Fenced code → the shared dark `CodeBlock` card (same one briefings, artifacts,
 * and the reasoning/narration prose use, via `MarkdownPre`). Inline code has no
 * `<pre>` parent, so it falls through to the wrapper's `[&_:not(pre)>code]` chip
 * styling above.
 */
const BASE_COMPONENTS: Components = { pre: MarkdownPre };

/** Streaming variant: each word in a paragraph / list item fades up out of a blur. */
const STREAMING_COMPONENTS: Components = {
  ...BASE_COMPONENTS,
  p: ({ children }) => <p>{animateWords(children)}</p>,
  li: ({ children }) => <li>{animateWords(children)}</li>,
};

/** A delimiter row (`|---|:--:|`), possibly still being typed mid-stream. */
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*$/;

/**
 * Hide an incomplete trailing GFM table while streaming. remark-gfm doesn't
 * recognize a table until its delimiter row (`|---|---|`) is fully typed, so a
 * header that has arrived ahead of it briefly renders as literal `| a | b |`
 * pipe text — and the half-typed dashes too — before snapping into a table.
 * We withhold that trailing fragment until the first data row begins, so the
 * table appears already-formed and then fills in row by row (the rows after the
 * delimiter stream in fine on their own). Only the *trailing* block is touched,
 * and only while streaming; a completed table and prose containing a stray `|`
 * are left untouched.
 */
function hideIncompleteTableTail(text: string): string {
  // Cheap bail-out before splitting the whole (growing) text on every streamed
  // token: we only ever hold back a trailing table header, whose last non-blank
  // line contains a pipe. Scan back over trailing whitespace to that line — if
  // it has no `|`, nothing is held back, so skip the O(n) split (keeps streaming
  // linear instead of O(n²)).
  let last = text.length - 1;
  while (last >= 0 && /\s/.test(text[last]!)) last--;
  if (last < 0) return text; // all blank
  const lastLineStart = text.lastIndexOf("\n", last) + 1;
  if (!text.slice(lastLineStart, last + 1).includes("|")) return text;

  const lines = text.split("\n");
  // Ignore trailing blank lines: a header that just gained its newline
  // (`| a | b |\n`) is still a header-only fragment, not a finished block.
  let end = lines.length - 1;
  while (end >= 0 && lines[end]?.trim() === "") end--;
  if (end < 0) return text;
  // Walk back over the trailing run of pipe lines.
  let start = end + 1;
  for (let i = end; i >= 0; i--) {
    if (lines[i]?.includes("|")) start = i;
    else break;
  }
  if (start > end) return text; // no trailing pipe lines
  const block = lines.slice(start, end + 1);
  // A real table header starts the line with a pipe; a stray inline `|` in
  // prose (e.g. "a | b") does not, so we leave that alone.
  if (!/^\s*\|/.test(block[0] ?? "")) return text;
  const dataRowStarted = block.length > 2 && TABLE_DELIMITER.test(block[1] ?? "");
  if (dataRowStarted) return text; // valid table — render it and stream its rows
  return lines.slice(0, start).join("\n"); // hold back the header / partial delimiter
}

/**
 * Heal the text of an in-flight stream so half-typed markdown never flashes its
 * raw markers. Two layers, applied only while streaming:
 *
 *  1. {@link hideIncompleteTableTail} withholds an incomplete trailing GFM table
 *     (a block-level concern remend doesn't cover).
 *  2. `remend` auto-closes dangling inline tokens — `**bold`, `*em`, `_em`,
 *     `` `code ``, `~~strike~~` — and renders a half-typed link (`[label](http…`)
 *     as plain text (`linkMode: "text-only"`) until the closing paren arrives.
 *
 * We adopt remend rather than a hand-rolled healer: it's a zero-dependency ~12KB
 * ESM string transformer (Vercel's streamdown) that already gets the CommonMark
 * flanking-delimiter, escaped-backtick, and code-span-context edge cases right —
 * the parts a local healer quietly gets wrong. `katex` is disabled because this
 * chat render path wires only remark-gfm + remark-breaks (no math), so there's
 * nothing to heal a `$$` into. Healing touches streamed frames only; the final
 * persisted body is complete markdown and renders untouched.
 */
function healStreamingMarkdown(text: string): string {
  return remend(hideIncompleteTableTail(text), { linkMode: "text-only", katex: false });
}

/** Assistant markdown body, with a blinking caret + per-word reveal while streaming. */
export function AssistantMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const body = streaming ? healStreamingMarkdown(text) : text;
  return (
    <div
      // The reply reads at a larger scale than the rail, so its fenced code
      // stays 13px; `--md-code-fs` cascades into the shared CodeBlock's
      // highlighter (which defaults to the rail's 11.5px).
      style={{ "--md-code-fs": "13px" } as React.CSSProperties}
      className={cn("text-sm leading-relaxed tracking-tight text-app-fg-4", MARKDOWN_CLASSES)}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={streaming ? STREAMING_COMPONENTS : BASE_COMPONENTS}
      >
        {body}
      </ReactMarkdown>
      {streaming ? (
        <span className="animate-chat-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-app-fg-3 align-middle" />
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
  // Bump to remount the <img> on retry — forces a fresh fetch after a transient
  // load failure instead of leaving the placeholder stuck forever.
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

/** A persisted message (user or assistant) from the synced store. */
export function MessageBubble({
  message,
  attachments,
  onRetry,
  onRetryWithoutAttachments,
}: {
  message: SyncedChatMessage;
  /** Image attachments on this (user) message, from the synced store. */
  attachments?: SyncedChatAttachment[];
  /** Present on a failed assistant reply — re-sends the user turn behind it. */
  onRetry?: () => void;
  /** Present when the failed turn can be recovered by dropping attachments. */
  onRetryWithoutAttachments?: () => void;
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
          <div className="max-w-[80%] rounded-2xl bg-app-bg-2 px-4 py-2.5 text-sm leading-relaxed tracking-tight whitespace-pre-wrap text-app-fg-4">
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
      {import.meta.env.DEV && message.usage ? <UsageLine usage={message.usage} /> : null}
    </div>
  );
}

/** Compact token count: 1234 → "1.2k", 512 → "512". */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Trim a model id's dated suffix for the readout ("claude-haiku-4-5-20251001" → "claude-haiku-4-5"). */
function shortModel(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

/**
 * Dev-only per-turn token + cost readout under an assistant reply. Gated on
 * `import.meta.env.DEV` (stripped from prod bundles) — it exposes the raw
 * economics of the turn (boss run only; sub-agents bill separately) so we can
 * eyeball cost while iterating. Numbers come from the synced `usage` rollup
 * (aggregated server-side from `api_call_log`); absent on older messages.
 *
 * The served model(s) are shown so a silent provider fallback is visible at a
 * glance — a turn you expected on `claude-*` showing `gemini-*` means the
 * Anthropic primary errored (spend cap, 429) and `withFallback` degraded it.
 */
function UsageLine({ usage }: { usage: NonNullable<SyncedChatMessage["usage"]> }) {
  const cost =
    usage.costUsd >= 0.01 ? `$${usage.costUsd.toFixed(3)}` : `$${usage.costUsd.toFixed(5)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-app-fg-2 tabular-nums">
      <span title="Input tokens">↑ {formatTokens(usage.inputTokens)}</span>
      <span aria-hidden>·</span>
      <span title="Output tokens">↓ {formatTokens(usage.outputTokens)}</span>
      {usage.cachedInputTokens > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span title="Cached input tokens">⚡ {formatTokens(usage.cachedInputTokens)}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span title="Turn cost (boss run)" className="text-app-fg-3">
        {cost}
      </span>
      <span aria-hidden>·</span>
      <span title="LLM calls this turn">{usage.calls} calls</span>
      {usage.models.map((m) => (
        <span
          key={m.model}
          title="Model served this turn (× call count)"
          className="rounded bg-app-bg-2 px-1 text-app-fg-3"
        >
          {shortModel(m.model)}
          {m.calls > 1 ? ` ×${m.calls}` : ""}
        </span>
      ))}
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
