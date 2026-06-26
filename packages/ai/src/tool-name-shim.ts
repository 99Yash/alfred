import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
// ai-retry's `LanguageModel` alias is the concrete `LanguageModelV3` instance
// type — the same narrowing `provider.ts` and `withFallback` use.
import type { LanguageModel as LanguageModelV3 } from "ai-retry";

/**
 * Anthropic boundary shim for our dotted tool-name convention.
 *
 * Alfred names every tool `integration.action` (`drive.search_files`,
 * `system.read_user_context`) — see `ToolName` in `@alfred/contracts`. But
 * Anthropic's API rejects tool names that don't match `^[a-zA-Z0-9_-]{1,128}$`:
 * **dots are illegal**. `@ai-sdk/anthropic` passes `tool.name` through verbatim
 * (no sanitization), so every tool-bearing call to a Claude model used to 400
 * (`tools.0.custom.name: String should match pattern …`). Because the chat/boss
 * models are `withFallback(sonnet, gemini)`, that 400 silently degraded every
 * turn to Gemini (the weaker agent that punts) — "standard = Sonnet" was fiction.
 *
 * This middleware maps `.`↔`__` **only at the Anthropic provider edge**, leaving
 * the dotted convention intact everywhere else (the `ToolName` type, prompts,
 * the dispatch parser, `TOOL_LABELS`). On the way in it rewrites `.`→`__` in the
 * tools array, the tool choice, and any tool-call/result parts already in the
 * prompt (so the conversation history stays consistent with the tools array). On
 * the way out it maps the model's tool calls `__`→`.` so the rest of the stack
 * still sees the dotted names it expects.
 *
 * The encoding is reversible because of two `ToolName` invariants: exactly one
 * `.` per name, and no `__` anywhere (integration slugs are single words, action
 * slugs use single underscores). So `String.replace` on the first occurrence
 * round-trips cleanly: `drive.search_files` → `drive__search_files` → back.
 */

// Exported for the registry invariant test (`tool-name-shim.test.ts`), which
// asserts these round-trip over every real `ToolName` — the reversibility this
// encoding depends on (exactly one `.`, no `__`).
export const encodeToolName = (name: string): string => name.replace(".", "__");
export const decodeToolName = (name: string): string => name.replace("__", ".");

// Derive the SDK's call-options / result shapes off the middleware type so we
// don't take a direct dep on `@ai-sdk/provider` for these granular types.
type CallOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>>;
type ContentPart = GenerateResult["content"][number];
type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type PromptMessage = CallOptions["prompt"][number];
type MessagePart = Extract<PromptMessage["content"], readonly unknown[]>[number];

/** Rewrite the `toolName` on a prompt tool-call/result part (outbound, `.`→`__`). */
function encodeMessagePart(part: MessagePart): MessagePart {
  if ((part.type === "tool-call" || part.type === "tool-result") && "toolName" in part) {
    return { ...part, toolName: encodeToolName(part.toolName) };
  }
  return part;
}

function encodePromptMessage(message: PromptMessage): PromptMessage {
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(encodeMessagePart) } as PromptMessage;
}

/** Map every tool name in the outgoing request `.`→`__` for Anthropic. */
function encodeParams(params: CallOptions): CallOptions {
  return {
    ...params,
    tools: params.tools?.map((t) =>
      t.type === "function" ? { ...t, name: encodeToolName(t.name) } : t,
    ),
    toolChoice:
      params.toolChoice?.type === "tool"
        ? { ...params.toolChoice, toolName: encodeToolName(params.toolChoice.toolName) }
        : params.toolChoice,
    prompt: params.prompt.map(encodePromptMessage),
  };
}

/** Rewrite the `toolName` on a response content part (inbound, `__`→`.`). */
function decodeContentPart(part: ContentPart): ContentPart {
  if (
    (part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request") &&
    "toolName" in part
  ) {
    return { ...part, toolName: decodeToolName(part.toolName) };
  }
  return part;
}

/** Rewrite the `toolName` on a streamed part (inbound, `__`→`.`). */
function decodeStreamPart(part: StreamPart): StreamPart {
  if (
    (part.type === "tool-input-start" ||
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request") &&
    "toolName" in part
  ) {
    return { ...part, toolName: decodeToolName(part.toolName) };
  }
  return part;
}

const toolNameShimMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => encodeParams(params),
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return { ...result, content: result.content.map(decodeContentPart) };
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform: (chunk, controller) => controller.enqueue(decodeStreamPart(chunk)),
        }),
      ),
    };
  },
};

/**
 * Wrap an Anthropic model so the dotted `integration.action` tool names survive
 * the round-trip through Anthropic's pattern-validated API. Apply to every
 * Anthropic model that carries tools (boss, sub-agent, chat); harmless on
 * tool-less calls (the middleware is a no-op when there are no tool names).
 * Provider/modelId are proxied unchanged, so cost attribution and the
 * served-model id (#216) still see `anthropic` / `claude-…`.
 */
export function withAnthropicToolNames(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({ model, middleware: toolNameShimMiddleware }) as LanguageModelV3;
}
