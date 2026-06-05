import type { SyncedChatMessage } from "@alfred/sync";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";
import { ToolCallCard, type ToolCallView } from "./tool-call-card";

const MARKDOWN_CLASSES = cn(
  "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_a]:text-vs-purple-4 [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-vs-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-vs-bg-2 [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-vs-fg-a1 [&_blockquote]:pl-3 [&_blockquote]:text-vs-fg-3",
);

/** Assistant markdown body, with a blinking caret while the turn is streaming. */
export function AssistantMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn("text-[15px] leading-relaxed text-vs-fg-4", MARKDOWN_CLASSES)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
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
  return (
    <div className="flex flex-col gap-2">
      {tools.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {tools.map((t) => (
            <ToolCallCard key={t.toolCallId} tool={t} />
          ))}
        </div>
      ) : null}
      {message.content.length > 0 ? <AssistantMarkdown text={message.content} /> : null}
    </div>
  );
}
