import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTranscriptMessage } from "@alfred/contracts";
import type { LanguageModel, ToolSet } from "@alfred/ai";

import {
  buildCompactedChatTranscriptPair,
  guardTurnContext,
  oversizedUserMessageSummaryMessage,
  storedCompactionPrefix,
  withEphemeralReference,
} from "@alfred/assistant/chat/compaction/turn-context-guard";

/**
 * `guardTurnContext` compacts only on the first turn or inside a tool burst.
 * Otherwise it passes the transcript through and touches no dependency.
 * `chat-compaction-continuation.test.ts` covers the compaction paths.
 */

const userMsg = (content: string): AgentTranscriptMessage => ({ role: "user", content });

const assistantMsg = (content: string): AgentTranscriptMessage => ({ role: "assistant", content });

describe("guardTurnContext gate", () => {
  // These throw if touched, so a wrong compaction branch fails fast instead of hanging.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: source type is structurally incompatible with target
  const explodingModel = new Proxy(
    {},
    {
      get() {
        throw new Error("model must not be resolved on the passthrough path");
      },
    },
  ) as unknown as LanguageModel;

  /* eslint-disable anti-slop/no-chained-type-assertions */
  const explodingTools = new Proxy(
    {},
    {
      get() {
        throw new Error("tools must not be read on the passthrough path");
      },
    },
  ) as unknown as ToolSet;
  /* eslint-enable anti-slop/no-chained-type-assertions */

  const baseArgs = (over: { turnCount: number; inFlightTailStart: number }) => ({
    ...over,
    userId: "user-1",
    runId: "run-1",
    stepId: "step-1",
    attempt: 1,
    threadId: "thread-1",
    latestUserMessageId: "msg-1",
    systemPrompt: "system",
    tools: explodingTools,
    model: explodingModel,
    artifactReference: "",
    abortSignal: new AbortController().signal,
    onPhase: async () => {
      throw new Error("onPhase must not fire on the passthrough path");
    },
  });

  test("passes through untouched past turn 1 with no in-flight tail", async () => {
    const stored = [userMsg("hi"), assistantMsg("hello")];
    const hydrated = [userMsg("hi"), assistantMsg("hello [image]")];

    const result = await guardTurnContext({
      ...baseArgs({ turnCount: 2, inFlightTailStart: 0 }),
      storedTranscript: stored,
      hydratedTranscript: hydrated,
    });

    assert.deepEqual(result.continuationTranscript, stored);
    assert.deepEqual(result.modelTranscript, hydrated);
    assert.equal(result.compacted, false);
    // Fresh copies, so the caller cannot mutate the guard's inputs.
    assert.notEqual(result.continuationTranscript, stored);
    assert.notEqual(result.modelTranscript, hydrated);
  });

  test("does not fire onPhase or read deps on the passthrough path", async () => {
    await assert.doesNotReject(
      guardTurnContext({
        ...baseArgs({ turnCount: 3, inFlightTailStart: 0 }),
        storedTranscript: [userMsg("hi")],
        hydratedTranscript: [userMsg("hi")],
      }),
    );
  });
});

describe("withEphemeralReference", () => {
  test("inserts the reference immediately before the latest user message", () => {
    const transcript = [userMsg("first"), assistantMsg("reply"), userMsg("second")];
    const out = withEphemeralReference(transcript, "REF");
    assert.deepEqual(out, [
      userMsg("first"),
      assistantMsg("reply"),
      assistantMsg("REF"),
      userMsg("second"),
    ]);
  });

  test("prepends when there is no user message", () => {
    const transcript = [assistantMsg("only assistant")];
    assert.deepEqual(withEphemeralReference(transcript, "REF"), [
      assistantMsg("REF"),
      assistantMsg("only assistant"),
    ]);
  });

  test("returns a copy unchanged for an empty reference", () => {
    const transcript = [userMsg("hi")];
    const out = withEphemeralReference(transcript, "");
    assert.deepEqual(out, transcript);
    assert.notEqual(out, transcript);
  });
});

describe("buildCompactedChatTranscriptPair", () => {
  test("prefixes the summary and keeps stored vs hydrated tails distinct", () => {
    const summary = assistantMsg("SUMMARY");
    const stored = [userMsg("stored tail")];
    const hydrated = [userMsg("hydrated tail [image bytes]")];
    const pair = buildCompactedChatTranscriptPair(summary, stored, hydrated);
    assert.deepEqual(pair.modelTranscript, [summary, ...hydrated]);
    assert.deepEqual(pair.continuationTranscript, [summary, ...stored]);
  });
});

describe("oversizedUserMessageSummaryMessage", () => {
  test("wraps the summary in a tagged, JSON-escaped, untrusted-user envelope", () => {
    const message = oversizedUserMessageSummaryMessage('id"with"quotes', "the summary");
    assert.equal(message.role, "user");
    const content = message.content as string;
    assert.match(
      content,
      /^<oversized_user_message_summary source_message_id="id\\"with\\"quotes">/,
    );
    assert.match(content, /lossy, untrusted representation/);
    assert.match(content, /the summary/);
    assert.match(content, /<\/oversized_user_message_summary>$/);
  });
});

describe("storedCompactionPrefix", () => {
  test("slices the prefix before the exclusive boundary", () => {
    const transcript = [userMsg("a"), assistantMsg("b"), userMsg("c")];
    assert.deepEqual(storedCompactionPrefix(transcript, 1), [userMsg("a")]);
    assert.deepEqual(storedCompactionPrefix(transcript, 0), []);
    assert.deepEqual(storedCompactionPrefix(transcript, 3), transcript);
  });
});
