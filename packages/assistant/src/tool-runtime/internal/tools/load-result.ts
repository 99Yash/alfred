/**
 * `system.load_result`: a script reads a stored result by its handle (ADR-0087 points 1 and 3,
 * ADR-0130 decision 5). It is a `codeModeRead` tool, so in a chat that reads through scripts it runs
 * only inside `system.code_run`. The read is scoped to the user and the chat thread of the call.
 */
import {
  loadResultInput,
  storedResultSchema,
  type JsonValue,
  type ReadEvidence,
  type ResultTruncation,
} from "@alfred/contracts";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { RESULT_HANDLE_TTL_DAYS, resultHandleStore } from "../../result-handle-store";
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
      /** Set when the stored copy itself was cut at the stored cap. */
      truncation?: ResultTruncation;
    }
  | { found: false; handle: string; message: string };

const NOT_FOUND =
  "No stored result has this handle in this chat. It may have expired " +
  `(${RESULT_HANDLE_TTL_DAYS} days after its fetch). Fetch the data again.`;

/** The evidence store of a load. Its `version` is the ISO fetch time of the stored result. */
export const RESULT_HANDLE_EVIDENCE_STORE = "result_handle";

function loadResultEvidence(output: LoadResultOutput): ReadEvidence {
  if (!output.found) return itemEvidence([]);

  return itemEvidence([
    {
      ref: {
        kind: "record",
        store: RESULT_HANDLE_EVIDENCE_STORE,
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

    const copy = storedResultSchema.safeParse(stored.value);

    // A blob that is not the park step's shape is not a result Alfred can vouch for.
    if (!copy.success) return { found: false, handle: input.handle, message: NOT_FOUND };

    const { value, truncation } = copy.data;

    return {
      found: true,
      handle: stored.handle,
      toolName: stored.toolName,
      query: stored.query,
      fetchedAt: stored.fetchedAt.toISOString(),
      value,
      ...(truncation ? { truncation } : {}),
    };
  },
  readEvidence: loadResultEvidence,
});
