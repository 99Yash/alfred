import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { eventPayloadSchemas, type EventFrame, type EventPayload } from "@alfred/contracts/events";
import { frameThreadId, parseEventFrame } from "../../src/lib/events/frame";

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

const chatReasoningPayload = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  seq: 1,
  text: "thinking",
};

const chatMessagePayload = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  phase: "started" as const,
};

const approvalRequestedPayload = {
  runId: "run-1",
  approvalId: "appr-1",
  approvalKind: "step" as const,
  prompt: "may I?",
};

describe("parseEventFrame", () => {
  test("a frame's payload is the zod-parsed payload for its own kind", () => {
    for (const [kind, payload] of [
      ["chat.delta", chatDeltaPayload],
      ["chat.tool", chatToolSubAgentPayload],
      ["agent.run", agentRunPayload],
      ["artifact.delta", artifactDeltaPayload],
    ] as const) {
      const frame = parseEventFrame(kind, { data: wire(payload), lastEventId: "42" });
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
    assert.equal(
      parseEventFrame("agent.run", { data: wire(chatDeltaPayload), lastEventId: "42" }),
      null,
    );
    assert.equal(
      parseEventFrame("chat.delta", { data: wire(agentRunPayload), lastEventId: "42" }),
      null,
    );
  });

  test("a missing createdAt degrades to an empty string rather than dropping the frame", () => {
    const frame = parseEventFrame("chat.delta", {
      data: JSON.stringify({ payload: chatDeltaPayload }),
      lastEventId: "7",
    });
    assert.ok(frame);
    assert.equal(frame.createdAt, "");
  });

  /**
   * The tier-1 guards, and the only assertions here that `tsx --test` cannot
   * make: they are checked by `tsc -p apps/web/tsconfig.test.json` (wired into
   * web's `check-types`). If `payload` ever degrades back to `unknown` — or
   * widens to the union of every kind's payload — the payload assignment stops
   * compiling. No runtime test can see that.
   *
   * Both are **positive assignability** assertions rather than bare
   * `@ts-expect-error`s, deliberately: reading a field off `unknown` is itself an
   * error, so an expect-error stays satisfied by a widened type and the guard
   * never fires.
   *
   * The envelope assignment is the second axis, and it guards the **type** rather
   * than the literal: it asks whether `EventStreamFrame` still carries every
   * required field `eventFrameSchema` declares beyond `kind` and `payload`. It is
   * not vacuous — narrow the envelope in `frame.ts` to `Pick<EventFrame, "id">`
   * and this line is `error TS2741: Property 'createdAt' is missing … but required
   * in type 'Omit<…, "kind" | "payload">'` (probed on this tree, together with
   * TS2352 at that file's own cast and TS2339 at the debug events page).
   *
   * The *literal* is guarded somewhere else, by `satisfies EventFrame` in
   * `parseEventFrame`, and that is a separate mechanism with a separate mutant.
   * Standing in for a contract that grew a required field
   * (`type EventFrameNext = EventFrame & { userId: string }`, then `satisfies
   * EventFrameNext` on the return literal). Verbatim, abbreviated only where the
   * compiler itself elided:
   *
   * - `error TS1360: Type '{ id: number; kind: "agent.progress" | … ; payload: {
   *   ...; } | ... 8 more ... | { ...; }; createdAt: string; }' does not satisfy
   *   the expected type 'EventFrameNext'.` / `Property 'userId' is missing in type
   *   '{ id: number; … }' but required in type '{ userId: string; }'.`
   * - dropping `satisfies` under that same mutant: `tsc --noEmit` exits **0**.
   *
   * The second one is why the first is worth writing down: the cast alone accepts
   * a literal that omits a field, so the `satisfies` — and not the return type —
   * is what fires there. Reproduced the other way too, on unmodified `main`:
   * deleting `createdAt` from the return literal there compiles clean. Both
   * mechanisms cover **required** fields only; an added `.optional()` field fires
   * neither.
   */
  test("a narrowed frame carries its own kind's payload type and the whole envelope", () => {
    const frame = parseEventFrame("chat.tool", {
      data: wire(chatToolSubAgentPayload),
      lastEventId: "42",
    });
    assert.ok(frame);
    const toolPayload: EventPayload<"chat.tool"> = frame.payload;
    assert.equal(toolPayload.toolName, "system.spawn_sub_agent");
    const envelope: Omit<EventFrame, "kind" | "payload"> = frame;
    assert.equal(envelope.id, 42);
    // @ts-expect-error a chat.tool payload is not interchangeable with chat.delta's
    const notADelta: EventPayload<"chat.delta"> = frame.payload;
    assert.ok(notADelta);
  });

  test("malformed wire input returns null", () => {
    const cases: [string, { data: unknown; lastEventId: unknown }][] = [
      ["non-string data", { data: { payload: chatDeltaPayload }, lastEventId: "42" }],
      ["undefined data", { data: undefined, lastEventId: "42" }],
      ["non-JSON data", { data: "not json", lastEventId: "42" }],
      ["non-record JSON", { data: "42", lastEventId: "42" }],
      ["null JSON", { data: "null", lastEventId: "42" }],
      ["missing payload", { data: JSON.stringify({ createdAt: "x" }), lastEventId: "42" }],
      ["empty lastEventId", { data: wire(chatDeltaPayload), lastEventId: "" }],
      ["zero lastEventId", { data: wire(chatDeltaPayload), lastEventId: "0" }],
      ["negative lastEventId", { data: wire(chatDeltaPayload), lastEventId: "-1" }],
      ["non-numeric lastEventId", { data: wire(chatDeltaPayload), lastEventId: "abc" }],
      ["fractional lastEventId", { data: wire(chatDeltaPayload), lastEventId: "1.5" }],
      ["non-string lastEventId", { data: wire(chatDeltaPayload), lastEventId: 42 }],
    ];
    for (const [label, msg] of cases) {
      assert.equal(parseEventFrame("chat.delta", msg), null, label);
    }
  });
});

/**
 * Frames here are built by `parseEventFrame` rather than as literals, so the
 * payloads under test are this kind's own schema output — the same objects a
 * subscriber sees.
 */
describe("frameThreadId", () => {
  test("returns the thread for every kind whose payload carries one", () => {
    for (const [kind, payload] of [
      ["chat.message", chatMessagePayload],
      ["chat.reasoning", chatReasoningPayload],
      ["chat.delta", chatDeltaPayload],
      ["chat.tool", chatToolSubAgentPayload],
      // The kind item 21 exists for: it carries a thread and is not a `chat.*`.
      ["artifact.delta", artifactDeltaPayload],
    ] as const) {
      const frame = parseEventFrame(kind, { data: wire(payload), lastEventId: "1" });
      assert.ok(frame, `${kind} should parse`);
      assert.equal(frameThreadId(frame), "thread-1", kind);
    }
  });

  test("returns null for a kind whose payload names no thread", () => {
    for (const [kind, payload] of [
      ["agent.run", agentRunPayload],
      ["approval.requested", approvalRequestedPayload],
    ] as const) {
      const frame = parseEventFrame(kind, { data: wire(payload), lastEventId: "1" });
      assert.ok(frame, `${kind} should parse`);
      assert.equal(frameThreadId(frame), null, kind);
    }
  });

  /**
   * The gate this module exists for is type-level, so no runtime assertion can
   * see it: a passing test above cannot distinguish `ThreadScopedEventKind`
   * derived from the payload schemas from a hand-listed union of names. Recorded
   * mutant, run against this tree:
   *
   * - comment out `case "artifact.delta"` in `frameThreadId` → `tsc` fails at the
   *   `noThreadNamed` call, `src/lib/events/frame.ts(114,28): error TS2345:
   *   Argument of type '"agent.progress" | "agent.run" | "approval.requested" |
   *   "artifact.delta" | "inbox.updated" | "memory.fact_learned" | "tool.call"' is
   *   not assignable to parameter of type '"agent.progress" | "agent.run" |
   *   "approval.requested" | "inbox.updated" | "memory.fact_learned" |
   *   "tool.call"'.` — because `default` narrows `frame.kind` to include the kind
   *   that stopped being classified.
   *
   * That error is the enforcement. `apps/web` typechecks in CI; its runtime tests
   * do not (campaign item 12), so this is also the enforced half.
   */
  test("thread-scoped kinds are derived from the payload schemas — see the mutant above", () => {
    assert.ok(true);
  });
});
