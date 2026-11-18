/**
 * What each `system.*` read delivered, as the reader states it (ADR-0124 amendment 2026-11-18,
 * the evidence record). Each function reads the typed output of one tool and returns its
 * `ToolEffects.evidence`. A search hit gives `depth: "hit"` (a title or a snippet). A read of the
 * item gives `depth: "body"`.
 */

import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  sanitizeErrorMessage,
  truncatedCoverage,
  type ReadEvidence,
  type ReadEvidenceRefDraft,
} from "@alfred/contracts";
import { itemEvidence, type DeliveredItem } from "../../item-evidence";
import type {
  ChatHistoryToolResult,
  ListInstructionsResult,
  ListTodosResult,
  WebSearchToolResult,
} from "@alfred/assistant/tool-runtime";
import { redactCredentialUrl, type FetchUrlResult } from "./fetch-url";
import type { ReadScratchResult } from "./system";

/** The citations behind the answer. A citation holds a URL and a title, not the page. */
export function webSearchEvidence(output: WebSearchToolResult): ReadEvidence {
  return itemEvidence(
    output.citations.map((citation) => ({
      ref: webRef(citation.url, citation.title, "hit"),
      item: citation,
    })),
  );
}

/** The page that the fetch read, at its final URL. The text can be cut at the size cap. */
export function fetchUrlEvidence(output: FetchUrlResult): ReadEvidence {
  if (!output.ok) return itemEvidence([]);

  return itemEvidence(
    [{ ref: webRef(redactCredentialUrl(output.finalUrl), output.title, "body"), item: output }],
    truncatedCoverage(output.truncated),
  );
}

/**
 * A web reference with its title cut to the schema cap, so a long title does not drop a valid
 * page. The URL stays whole: `toReadEvidence` leaves out and counts a URL above its cap.
 */
function webRef(
  url: string,
  title: string | null | undefined,
  depth: ReadEvidenceRefDraft["depth"],
): ReadEvidenceRefDraft {
  const label = title ? sanitizeErrorMessage(title, EVIDENCE_CITATION_LABEL_MAX_CHARS) : "";

  return { kind: "web", url, ...(label ? { title: label } : {}), depth };
}

/** The chat messages, attachments, and tool calls whose excerpts the read returned. */
export function chatHistoryEvidence(output: ChatHistoryToolResult): ReadEvidence {
  if (!output.ok) return itemEvidence([]);

  if (output.mode === "search") {
    return itemEvidence(
      output.results.map((message) => chatRecord("chat_message", message.id, message)),
      truncatedCoverage(output.results.some((message) => message.content.truncated)),
    );
  }

  if (!output.found) return itemEvidence([]);

  const { result } = output;

  switch (result.kind) {
    case "message":
      return itemEvidence(
        [chatRecord("chat_message", result.id, result)],
        truncatedCoverage(result.content.truncated),
      );
    case "attachment":
      return itemEvidence(
        [chatRecord("chat_attachment", result.id, result)],
        truncatedCoverage(
          result.extractedText.truncated || result.representation?.truncated === true,
        ),
      );
    case "tool_call":
      return itemEvidence(
        [chatRecord("chat_tool_call", result.id, result)],
        truncatedCoverage(result.args.truncated || result.outcome.truncated),
      );
    default:
      return itemEvidence([]);
  }
}

function chatRecord(store: string, id: string, item: unknown): DeliveredItem {
  return { ref: { kind: "record", store, id, depth: "body" }, item };
}

/** The scratch entry, at the time that it was written. */
export function readScratchEvidence(output: ReadScratchResult): ReadEvidence {
  if (!output.found) return itemEvidence([]);

  return itemEvidence([
    {
      ref: {
        kind: "record",
        store: "scratch",
        id: output.key,
        depth: "body",
        version: String(output.entry.writtenAt),
      },
      item: output.entry,
    },
  ]);
}

/** The instruction rows, each at its revision. */
export function listInstructionsEvidence(output: ListInstructionsResult): ReadEvidence {
  return itemEvidence(
    output.instructions.map((summary) => ({
      ref: {
        kind: "record",
        store: "user_fact",
        id: summary.factId,
        depth: "body",
        version: String(summary.instruction.revision),
      },
      item: summary,
    })),
    output.truncated
      ? { truncated: true, returned: output.instructions.length, total: output.totalActive }
      : undefined,
  );
}

/** The todo rows. The list gives a name, a status, and sources, not the todo's history. */
export function listTodosEvidence(output: ListTodosResult): ReadEvidence {
  return itemEvidence(
    output.todos.map((todo) => ({
      ref: { kind: "record", store: "todo", id: todo.id, depth: "hit" },
      item: todo,
    })),
    output.truncated ? { truncated: true, returned: output.todos.length } : undefined,
  );
}
