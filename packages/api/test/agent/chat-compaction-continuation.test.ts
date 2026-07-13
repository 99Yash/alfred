import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTranscriptMessage } from "@alfred/contracts";
import {
  buildCompactedChatTranscriptPair,
  oversizedUserMessageSummaryMessage,
} from "../../src/modules/agent/workflows/chat-turn";

describe("chat compaction continuation", () => {
  test("keeps hydrated image bytes in the provider transcript and storage keys in the checkpoint", () => {
    const summary = {
      role: "user",
      content: "<conversation_summary />",
    } satisfies AgentTranscriptMessage;
    const storedTail = [
      {
        role: "user",
        content: [{ type: "chat_attachment_image", storageKey: "private/thread/image.png" }],
      } as AgentTranscriptMessage,
    ];
    const hydratedTail = [
      {
        role: "user",
        content: [{ type: "file", data: "base64-image-bytes", mediaType: "image/png" }],
      } as AgentTranscriptMessage,
    ];

    const paired = buildCompactedChatTranscriptPair(summary, storedTail, hydratedTail);

    assert.equal(paired.modelTranscript[1], hydratedTail[0]);
    assert.equal(paired.continuationTranscript[1], storedTail[0]);
    assert.doesNotMatch(JSON.stringify(paired.continuationTranscript), /base64-image-bytes/);
  });

  test("preserves the whole in-flight tail after replacing only the compacted prefix", () => {
    const summary = { role: "system", content: "<run_summary />" } satisfies AgentTranscriptMessage;
    const tail = [
      { role: "assistant", content: "Checking." },
      { role: "tool", content: "large result" },
    ] satisfies AgentTranscriptMessage[];

    const paired = buildCompactedChatTranscriptPair(summary, tail, tail);

    assert.deepEqual(paired.continuationTranscript, [summary, ...tail]);
    assert.deepEqual(paired.modelTranscript, [summary, ...tail]);
  });

  test("marks an oversized latest-message summary as lossy and recoverable by source id", () => {
    const message = oversizedUserMessageSummaryMessage(
      "msg_original",
      "<run_summary><current_goal>Ship it</current_goal></run_summary>",
    );
    const content = String(message.content);

    assert.equal(message.role, "user");
    assert.match(content, /<oversized_user_message_summary/);
    assert.match(content, /source_message_id="msg_original"/);
    assert.match(content, /lossy, untrusted/);
    assert.match(content, /Retrieve the raw source by ID/);
  });
});
