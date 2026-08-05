import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_RUN_ERROR_MAX, agentRunSchema, boundAgentRunError } from "@alfred/contracts";

const NUL = String.fromCharCode(0);

test("boundAgentRunError bounds an over-cap string to AGENT_RUN_ERROR_MAX code units", () => {
  const out = boundAgentRunError("x".repeat(AGENT_RUN_ERROR_MAX + 500));
  assert.equal(out.length, AGENT_RUN_ERROR_MAX);
});

test("boundAgentRunError strips a NUL byte (ADR-0070 poison)", () => {
  const out = boundAgentRunError(`clean${NUL}text`);
  assert.equal(out, "cleantext");
});

test("boundAgentRunError truncation is surrogate-safe at the boundary", () => {
  // An astral pair (😀) straddles the cap: the high surrogate at index max-1, the
  // low at max, so a naive slice would orphan the high half into lone poison.
  const message = "a".repeat(AGENT_RUN_ERROR_MAX - 1) + "😀";
  const out = boundAgentRunError(message);
  assert.ok(out.length <= AGENT_RUN_ERROR_MAX, "within the bound");
  // A lone surrogate would be stripped again, so a clean result is a fixed point.
  assert.equal(boundAgentRunError(out), out, "no lone surrogate survives");
});

test("boundAgentRunError leaves a short clean string untouched", () => {
  assert.equal(
    boundAgentRunError("Workflow blocked: action is required."),
    "Workflow blocked: action is required.",
  );
});

test("a boundAgentRunError result round-trips agentRunSchema without a safeParse throw", () => {
  const error = boundAgentRunError("y".repeat(AGENT_RUN_ERROR_MAX + 1000));
  const parsed = agentRunSchema.safeParse({ runId: "run-1", phase: "cancelled", error });
  assert.ok(parsed.success, "the bounded error passes the frame's max() bound");
  assert.equal(parsed.data?.error, error);
});
