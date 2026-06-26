import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelMessage } from "ai";
import { decorateTranscript, type Transcript } from "../src/agent.js";

/**
 * Pins the transcript cache breakpoint (#223). The boss re-sends the full
 * message history uncached every turn; this puts one Anthropic cacheControl
 * breakpoint on the last message so the prefix caches incrementally. The pure
 * transform is pinned here; the end-to-end cache *effect* is proven live by
 * src/scripts/probe-transcript-cache.ts.
 */

function anthropicCache(m: ModelMessage): unknown {
  return (m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl;
}

const sample = (): Transcript => [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "again" },
];

describe("decorateTranscript", () => {
  test("puts a cacheControl breakpoint on the last message only", () => {
    const out = decorateTranscript(sample(), "1h");
    assert.equal(anthropicCache(out[0]!), undefined);
    assert.equal(anthropicCache(out[1]!), undefined);
    assert.deepEqual(anthropicCache(out[2]!), { type: "ephemeral", ttl: "1h" });
  });

  test("honors the ttl", () => {
    const out = decorateTranscript(sample(), "5m");
    assert.deepEqual(anthropicCache(out[2]!), { type: "ephemeral", ttl: "5m" });
  });

  test("no-op when caching is disabled (non-Anthropic / tests)", () => {
    const input = sample();
    const out = decorateTranscript(input, undefined);
    assert.equal(out, input); // same reference — nothing to do
  });

  test("no-op on an empty transcript (first turn)", () => {
    const input: Transcript = [];
    const out = decorateTranscript(input, "1h");
    assert.equal(out, input);
  });

  test("does not mutate the caller's transcript or its messages", () => {
    const input = sample();
    const before = JSON.stringify(input);
    decorateTranscript(input, "1h");
    assert.equal(JSON.stringify(input), before);
    assert.equal(input[2]!.providerOptions, undefined);
  });

  test("preserves existing providerOptions on the last message", () => {
    const input: Transcript = [
      { role: "user", content: "x" },
      {
        role: "user",
        content: "y",
        providerOptions: { anthropic: { foo: "bar" }, openai: { baz: 1 } },
      },
    ];
    const out = decorateTranscript(input, "1h");
    const opts = out[1]!.providerOptions!;
    assert.deepEqual(opts.openai, { baz: 1 }); // untouched
    assert.equal((opts.anthropic as Record<string, unknown>).foo, "bar"); // preserved
    assert.deepEqual((opts.anthropic as Record<string, unknown>).cacheControl, {
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("moving the breakpoint forward as the transcript grows (incremental caching)", () => {
    // Turn N breaks at index 2; turn N+1 (two more messages) breaks at index 4.
    // The earlier messages stay clean, so the prior prefix is a cache read.
    const turnN = decorateTranscript(sample(), "1h");
    assert.notEqual(anthropicCache(turnN[2]!), undefined);

    const grown: Transcript = [
      ...sample(),
      { role: "assistant", content: "tool call" },
      { role: "tool", content: [] as never },
    ];
    const turnNplus1 = decorateTranscript(grown, "1h");
    assert.equal(anthropicCache(turnNplus1[2]!), undefined); // old breakpoint gone
    assert.notEqual(anthropicCache(turnNplus1[4]!), undefined); // moved to new end
  });
});
