/**
 * `system.load_result`: a script reads a stored result by its handle (ADR-0087 points 1 and 3,
 * ADR-0130 decision 5). It is a `codeModeRead` tool, so in a chat that reads through scripts it runs
 * only inside `system.code_run`. The read is scoped to the user and the chat thread of the call.
 */
import {
  isJsonObject,
  loadResultInput,
  type JsonValue,
  type ReadEvidence,
} from "@alfred/contracts";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { resultHandleStore } from "../../result-handle-store";
import { itemEvidence } from "../../item-evidence";

export type LoadResultOutput =
  | {
      found: true;
      handle: string;
      /** The tool and the input that made the result. */
      toolName: string;
      query: string;
      /** When the result was fetched. Fetch again when it is too old for the question. */
      fetchedAt: string;
      value: JsonValue;
      /** The note of `boundForModel`, when the stored copy itself was cut at the stored cap. */
      truncation?: JsonValue;
    }
  | { found: false; handle: string; message: string };

const NOT_FOUND =
  "No stored result has this handle in this chat. It may have expired (3 days after its fetch). " +
  "Fetch the data again.";

/** The stored blob is `{ value, truncation? }` (`parkResult`). */
function unpack(blob: JsonValue) {
  if (!isJsonObject(blob)) return { value: blob };

  const value = blob.value ?? null;

  return blob.truncation === undefined ? { value } : { value, truncation: blob.truncation };
}

function loadResultEvidence(output: LoadResultOutput): ReadEvidence {
  if (!output.found) return itemEvidence([]);

  return itemEvidence([
    {
      ref: {
        kind: "record",
        store: "result_handle",
        id: output.handle,
        depth: "body",
        version: output.fetchedAt,
      },
      item: output.value,
    },
  ]);
}

export const loadResultTool: RegisteredTool = liveTool({
  integration: "system",
  action: "load_result",
  riskTier: "no_risk",
  replay: "safe",
  codeModeRead: "ordinary",
  description:
    "Read a stored result by its handle: a cut result or an earlier script value of this chat. " +
    "Returns the whole value, the tool and input that made it, and its fetch time.",
  staging: "fast_path",
  inputSchema: loadResultInput,
  execute: async (input, ctx): Promise<LoadResultOutput> => {
    const store = resultHandleStore();
    const threadId = ctx.chat?.threadId;

    if (!store || threadId === undefined) {
      return { found: false, handle: input.handle, message: NOT_FOUND };
    }

    const stored = await store.load({ userId: ctx.userId, threadId, handle: input.handle });

    if (!stored) return { found: false, handle: input.handle, message: NOT_FOUND };

    return {
      found: true,
      handle: stored.handle,
      toolName: stored.toolName,
      query: stored.query,
      fetchedAt: stored.fetchedAt.toISOString(),
      ...unpack(stored.value),
    };
  },
  readEvidence: loadResultEvidence,
});
