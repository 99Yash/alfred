import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { eventPayloadSchemas, type EventPayload } from "@alfred/contracts/events";
import { parseEventFrame } from "../../src/lib/events/frame";

/** A wire message body as the SSE `data:` line carries it. */
const wire = (payload: unknown, createdAt = "2026-07-27T00:00:00.000Z") =>
  JSON.stringify({ payload, createdAt });

const chatDeltaPayload = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  seq: 3,
  text: "hello",
  segmentIndex: 1,
};

const chatToolSubAgentPayload = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  toolCallId: "call-1",
  toolName: "system.spawn_sub_agent",
  status: "started" as const,
  subAgent: { parentToolCallId: "call-0", subId: "sub_a", childRunId: "run-child" },
};

const agentRunPayload = { runId: "run-child", phase: "completed" as const };

const artifactDeltaPayload = {
  runId: "run-1",
  threadId: "thread-1",
  toolCallId: "call-1",
  seq: 1,
  text: "# Title",
  mode: "replace" as const,
};

describe("parseEventFrame", () => {
  test("a frame's payload is the zod-parsed payload for its own kind", () => {
    for (const [kind, payload] of [
      ["chat.delta", chatDeltaPayload],
      ["chat.tool", chatToolSubAgentPayload],
      ["agent.run", agentRunPayload],
      ["artifact.delta", artifactDeltaPayload],
    ] as const) {
      const frame = parseEventFrame(kind, wire(payload), "42");
      assert.ok(frame, `${kind} should parse`);
      assert.equal(frame.kind, kind);
      assert.equal(frame.id, 42);
      assert.equal(frame.createdAt, "2026-07-27T00:00:00.000Z");
      // The pairing under test: the payload came through THIS kind's schema,
      // defaults and all — not some other kind's.
      assert.deepEqual(frame.payload, eventPayloadSchemas[kind].parse(payload));
    }
  });

  test("a payload announced as the wrong kind is dropped, not passed through", () => {
    assert.equal(parseEventFrame("agent.run", wire(chatDeltaPayload), "42"), null);
    assert.equal(parseEventFrame("chat.delta", wire(agentRunPayload), "42"), null);
  });

  test("a missing createdAt degrades to an empty string rather than dropping the frame", () => {
    const frame = parseEventFrame("chat.delta", JSON.stringify({ payload: chatDeltaPayload }), "7");
    assert.ok(frame);
    assert.equal(frame.createdAt, "");
  });

  /**
   * The tier-1 guard, and the only assertion here that `tsx --test` cannot
   * make: it is checked by `tsc -p apps/web/tsconfig.test.json` (wired into
   * web's `check-types`). If `payload` ever degrades back to `unknown` — or
   * widens to the union of every kind's payload — the first assignment stops
   * compiling. No runtime test can see that.
   */
  test("a narrowed frame's payload is exactly its own kind's payload type", () => {
    const frame = parseEventFrame("chat.tool", wire(chatToolSubAgentPayload), "42");
    assert.ok(frame);
    const toolPayload: EventPayload<"chat.tool"> = frame.payload;
    assert.equal(toolPayload.toolName, "system.spawn_sub_agent");
    // @ts-expect-error a chat.tool payload is not interchangeable with chat.delta's
    const notADelta: EventPayload<"chat.delta"> = frame.payload;
    assert.ok(notADelta);
  });

  test("malformed wire input returns null", () => {
    const cases: [string, unknown, unknown][] = [
      ["non-string data", { payload: chatDeltaPayload }, "42"],
      ["undefined data", undefined, "42"],
      ["non-JSON data", "not json", "42"],
      ["non-record JSON", "42", "42"],
      ["null JSON", "null", "42"],
      ["missing payload", JSON.stringify({ createdAt: "x" }), "42"],
      ["empty lastEventId", wire(chatDeltaPayload), ""],
      ["zero lastEventId", wire(chatDeltaPayload), "0"],
      ["negative lastEventId", wire(chatDeltaPayload), "-1"],
      ["non-numeric lastEventId", wire(chatDeltaPayload), "abc"],
      ["fractional lastEventId", wire(chatDeltaPayload), "1.5"],
      ["non-string lastEventId", wire(chatDeltaPayload), 42],
    ];
    for (const [label, data, lastEventId] of cases) {
      assert.equal(parseEventFrame("chat.delta", data, lastEventId), null, label);
    }
  });
});
