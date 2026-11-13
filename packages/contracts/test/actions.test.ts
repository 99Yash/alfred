import assert from "node:assert/strict";
import test from "node:test";
import { leavesEffectUnconfirmed, unknownEffectEnvelopeSchema } from "@alfred/contracts";

test("leavesEffectUnconfirmed is true for a result with retry blocked", () => {
  const unknownEnvelope = unknownEffectEnvelopeSchema.parse({
    status: "unknown",
    retry: "blocked",
    message: "ambiguous delivery",
  });

  assert.equal(leavesEffectUnconfirmed(unknownEnvelope), true);
  // An MCP `blocked` result: a repeat was refused because an earlier attempt may have landed.
  assert.equal(
    leavesEffectUnconfirmed({ ok: false, status: "blocked", retry: "blocked", reason: "x" }),
    true,
  );
});

test("leavesEffectUnconfirmed is false for a result with no retry blocked", () => {
  assert.equal(leavesEffectUnconfirmed({ ok: false, status: "tool_error", result: {} }), false);
  assert.equal(leavesEffectUnconfirmed({ status: "completed", result: {} }), false);
  assert.equal(leavesEffectUnconfirmed({ status: "blocked", retry: "later" }), false);
  assert.equal(leavesEffectUnconfirmed(null), false);
  assert.equal(leavesEffectUnconfirmed(undefined), false);
  assert.equal(leavesEffectUnconfirmed("blocked"), false);
});
