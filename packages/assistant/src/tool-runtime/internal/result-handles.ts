/**
 * The park step (ADR-0087 points 1 and 2, ADR-0130 decision 5). From a new turn, an earlier result
 * is outside the transcript, so it is an overflow too. Thus a chat turn on the script read path
 * stores each script value, and each other result whose model copy the bound cut. A later script
 * reads a stored result with `system.load_result`, and the next turn gets one line for each.
 */
import {
  boundForModel,
  CODE_RUN_TOOL,
  collapseWhitespace,
  getStringPath,
  isJsonArray,
  isJsonObject,
  parseJsonContainer,
  toJsonValue,
  type JsonValue,
  type StoredResultCopy,
} from "@alfred/contracts";
import { logger } from "@alfred/logging";

import type { ProposedToolCall, ToolCallRun } from "../index";
import { resultHandleStore } from "../result-handle-store";
import { STORED_RESULT_MAX_BYTES } from "../code-mode/result-budget";

/** The most characters of the query on a transcript line. */
const QUERY_MAX_CHARS = 300;

/** How deep the item count looks for a list: a provider list sits under a few wrappers. */
const ITEM_COUNT_DEPTH = 4;

/**
 * What a result stores: the value of a completed script, or the whole result of another tool when
 * its model copy was cut. `null`: the result gets no handle.
 */
function storedValueOf(
  toolName: string,
  toolResult: JsonValue,
  modelCopyCut: boolean,
): JsonValue | null {
  if (toolName === CODE_RUN_TOOL) {
    if (!isJsonObject(toolResult) || getStringPath(toolResult, "status") !== "completed") {
      return null;
    }

    return toolResult.value ?? null;
  }

  return modelCopyCut ? toolResult : null;
}

/** The items of the largest list in `value`, to {@link ITEM_COUNT_DEPTH}. `null` with no list. */
function itemCountOf(value: JsonValue, depth = 0): number | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a JSON text leaf is the one string arm that can hold a list.
  if (typeof value === "string") {
    const parsed = parseJsonContainer(value);

    return parsed === null ? null : itemCountOf(parsed, depth);
  }

  let best: number | null = null;

  if (isJsonArray(value)) best = value.length;

  if (depth >= ITEM_COUNT_DEPTH) return best;

  const children = isJsonArray(value) ? value : isJsonObject(value) ? Object.values(value) : [];

  for (const child of children) {
    const count = itemCountOf(child, depth + 1);

    if (count !== null && (best === null || count > best)) best = count;
  }

  return best;
}

/**
 * When the stored data was fetched: now, or for a script that read stored results, the oldest of
 * their fetch times (`CodeRunResult.loadedFetchedAt`).
 */
function fetchedAtOf(toolName: string, toolResult: JsonValue): Date {
  const loaded =
    toolName === CODE_RUN_TOOL ? getStringPath(toolResult, "loadedFetchedAt") : undefined;

  const time = loaded === undefined ? Number.NaN : Date.parse(loaded);

  return Number.isNaN(time) ? new Date() : new Date(time);
}

/** The call input as one short line. */
function queryOf(call: ProposedToolCall): string {
  const text = collapseWhitespace(JSON.stringify(call.input ?? {}));

  return text.length > QUERY_MAX_CHARS ? `${text.slice(0, QUERY_MAX_CHARS)}…` : text;
}

/**
 * Store an executed result for a later read, and return its handle. Only the boss of a live chat
 * turn on the script read path parks: a handle belongs to a thread, and only a script reads it.
 * A storage failure gives no handle, so the bound note keeps its read-again advice.
 */
export async function parkResult(args: {
  run: ToolCallRun;
  call: ProposedToolCall;
  toolResult: JsonValue;
  modelCopyCut: boolean;
}): Promise<string | undefined> {
  const { run, call } = args;
  const store = resultHandleStore();

  if (!store || !run.chat || run.caller !== "boss" || run.runContext.readPath !== "code_run") {
    return undefined;
  }

  const value = storedValueOf(call.toolName, args.toolResult, args.modelCopyCut);

  if (value === null) return undefined;

  // Every stored value fits one delivery to a script, so a load needs no pages. A larger result
  // keeps its start, and its note says what was cut.
  const stored = boundForModel(value, STORED_RESULT_MAX_BYTES);

  // One shape for every blob (`storedResultSchema`), so a load parses it.
  const copy: StoredResultCopy = stored.truncation
    ? { value: stored.value, truncation: stored.truncation }
    : { value: stored.value };

  const storedValue = toJsonValue(copy);

  try {
    const ref = await store.park({
      userId: run.userId,
      threadId: run.chat.threadId,
      messageId: run.chat.messageId,
      runId: run.runId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      query: queryOf(call),
      itemCount: itemCountOf(value),
      fetchedAt: fetchedAtOf(call.toolName, args.toolResult),
      value: storedValue,
    });

    return ref?.handle;
  } catch (error) {
    logger.warn(
      { err: error, runId: run.runId, toolCallId: call.toolCallId, toolName: call.toolName },
      "[result-handles] park failed; the result has no handle",
    );

    return undefined;
  }
}
