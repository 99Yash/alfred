import type { SyncedChatMessage } from "@alfred/sync";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { animateWords } from "~/lib/chat/animate-text";
import { cn } from "~/lib/utils";
import { CodeBlock, InlineCode } from "./code-block";
import { ReasoningSection } from "./reasoning-section";
import { ToolCallCard, type ToolCallView } from "./tool-call-card";

const MARKDOWN_CLASSES = cn(
  "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_a]:text-vs-purple-4 [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-vs-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]",
  "[&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-vs-fg-a1 [&_blockquote]:pl-3 [&_blockquote]:text-vs-fg-3",
);

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

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
    <div className={cn("text-[15px] leading-relaxed text-vs-fg-4", MARKDOWN_CLASSES)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={streaming ? STREAMING_COMPONENTS : BASE_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
      {streaming ? (
        <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-chat-caret bg-vs-fg-3 align-middle" />
      ) : null}
    </div>
  );
}

/** A persisted message (user or assistant) from the synced store. */
export function MessageBubble({ message }: { message: SyncedChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-vs-bg-2 px-4 py-2.5 text-[15px] leading-relaxed text-vs-fg-4">
          {message.content}
        </div>
      </div>
    );
  }
  const tools = (message.toolCalls ?? []) as ToolCallView[];
  const failed = message.status === "failed";
  return (
    <div className="flex flex-col gap-2">
      {message.reasoning && message.reasoning.trim().length > 0 ? (
        <ReasoningSection
          reasoning={message.reasoning}
          active={false}
          durationMs={message.reasoningMs}
        />
      ) : null}
      {tools.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {tools.map((t) => (
            <ToolCallCard key={t.toolCallId} tool={t} />
          ))}
        </div>
      ) : null}
      {message.content.length > 0 ? <AssistantMarkdown text={message.content} /> : null}
      {failed ? (
        <p className="text-[13px] text-vs-red-4" role="alert">
          This reply didn&apos;t finish. Try sending your message again.
        </p>
      ) : null}
    </div>
  );
}
