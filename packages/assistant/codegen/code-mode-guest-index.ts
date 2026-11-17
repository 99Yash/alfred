/**
 * Codegen input for the Code Mode index (ADR-0124 decision 3). Never imported, never run.
 *
 * `scripts/generate-code-mode-index.mjs` compiles this file with declaration emit. The compiler
 * prints each `guest<T>()` call as the expanded JSON form of `T`, which is the value a script gets
 * from that host function, because dispatch sanitizes every result to JSON. The script copies the
 * printed types into `src/tool-runtime/code-mode/guest-index.generated.ts`, and `pnpm check` fails
 * when that file is stale.
 *
 * Each type here is the one the tool's `execute` is annotated with, so a change to a tool's
 * result changes the index.
 */

import type { JsonValue, PassthroughResult } from "@alfred/contracts";
import type { z } from "zod";
import type {
  ChatHistoryToolResult,
  ContextSearchToolResult,
  ListInstructionsResult,
  ListTodosResult,
  ReadUserContextResult,
  WebSearchToolResult,
} from "../src/tool-runtime/index";
import type {
  ContactsGetResult,
  ContactsListResult,
  ContactsSearchResult,
} from "../src/tool-runtime/internal/tools/contacts";
import type { CorpusSearchToolResult } from "../src/tool-runtime/internal/tools/corpus";
import type { FetchUrlResult } from "../src/tool-runtime/internal/tools/fetch-url";
import type {
  McpBrokerToolResult,
  McpInspectToolResult,
  McpListToolsResult,
} from "../src/tool-runtime/internal/tools/mcp";
import type { ReadScratchResult } from "../src/tool-runtime/internal/tools/system";
import type {
  VercelListDeploymentsResult,
  VercelListProjectsResult,
} from "../src/tool-runtime/internal/tools/vercel";

/**
 * The JSON form of `T`. The printer reuses an alias name for any type that has the same structure
 * as a declared one, so three markers make each level new, and the generator removes them: a `§`
 * before each string literal, a `"§"?: never` key in each object, and `"§JsonValue"` for the
 * recursive `JsonValue`, which the printer would elide.
 */
type Guest<T> = unknown extends T
  ? unknown
  : [JsonValue] extends [T]
    ? "§JsonValue"
    : [z.core.util.JSONType] extends [T]
      ? "§JsonValue"
      : T extends Date
        ? string
        : T extends string
          ? string extends T
            ? string
            : // A branded string has keys that `string` lacks; the model sees a plain string.
              [Exclude<keyof T, keyof string>] extends [never]
              ? `§${T}`
              : string
          : T extends number | boolean | null
            ? T
            : T extends undefined | bigint | symbol | ((...args: never[]) => void)
              ? never
              : T extends readonly (infer U)[]
                ? Guest<U>[]
                : T extends object
                  ? {
                      -readonly [K in keyof T as T[K] extends (...args: never[]) => void
                        ? never
                        : K]: Guest<T[K]>;
                    } & { "§"?: never } extends infer O
                    ? { [K in keyof O]: O[K] }
                    : never
                  : never;

declare function guest<T>(): Guest<T>;

/**
 * One entry per host path: a `codeModeRead` tool name, or `mcp.read`. `codeRunDescription` checks the
 * keys against the registered read tools at boot.
 */
export const GUEST_OUTPUTS = {
  "contacts.search": guest<ContactsSearchResult>(),
  "contacts.list": guest<ContactsListResult>(),
  "contacts.get": guest<ContactsGetResult>(),
  "vercel.list_projects": guest<VercelListProjectsResult>(),
  "vercel.list_deployments": guest<VercelListDeploymentsResult>(),
  "vercel.request": guest<PassthroughResult>(),
  "system.web_search": guest<WebSearchToolResult>(),
  "system.fetch_url": guest<FetchUrlResult>(),
  "system.search_context": guest<ContextSearchToolResult>(),
  "system.corpus_search": guest<CorpusSearchToolResult>(),
  "system.read_chat_history": guest<ChatHistoryToolResult>(),
  "system.read_user_context": guest<ReadUserContextResult>(),
  "system.list_instructions": guest<ListInstructionsResult>(),
  "system.list_todos": guest<ListTodosResult>(),
  "system.read_scratch": guest<ReadScratchResult>(),
  "mcp.list_tools": guest<McpListToolsResult>(),
  "mcp.inspect_tool": guest<McpInspectToolResult>(),
  "mcp.read": guest<McpBrokerToolResult>(),
};
