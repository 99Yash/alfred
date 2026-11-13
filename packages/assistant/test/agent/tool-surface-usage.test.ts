import type { TranscriptMessage } from "@alfred/ai";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";

import {
  invokedToolNamesFromTranscript,
  summarizeToolSurfaceUsage,
} from "@alfred/assistant/execution/tool-surface-usage";

const KERNEL = new Set<ToolName>([
  "system.search_tools",
  "system.load_tool",
  "system.current_time",
]);

describe("summarizeToolSurfaceUsage", () => {
  test("splits loaded tools into used and unused, excluding the kernel", () => {
    const usage = summarizeToolSurfaceUsage({
      activeTools: [
        "system.search_tools", // kernel — never counted
        "system.load_tool", // kernel
        "contacts.get", // loaded + used
        "contacts.search", // loaded + unused
        "contacts.list", // loaded + unused
      ],
      preloadedTools: ["contacts.get", "contacts.search"],
      kernelTools: KERNEL,
      invokedTools: new Set(["contacts.get", "system.current_time"]),
    });

    assert.deepEqual(usage.loaded, ["contacts.get", "contacts.list", "contacts.search"]);
    assert.deepEqual(usage.usedLoaded, ["contacts.get"]);
    assert.deepEqual(usage.unusedLoaded, ["contacts.list", "contacts.search"]);
    assert.deepEqual(usage.preloaded, ["contacts.get", "contacts.search"]);
    assert.deepEqual(usage.usedPreloaded, ["contacts.get"]);
    assert.deepEqual(usage.unusedPreloaded, ["contacts.search"]);
  });

  test("a kernel-only run has nothing loaded and nothing unused", () => {
    const usage = summarizeToolSurfaceUsage({
      activeTools: ["system.search_tools", "system.load_tool"],
      preloadedTools: [],
      kernelTools: KERNEL,
      invokedTools: new Set(),
    });

    assert.deepEqual(usage.loaded, []);
    assert.deepEqual(usage.usedLoaded, []);
    assert.deepEqual(usage.unusedLoaded, []);
    assert.deepEqual(usage.preloaded, []);
    assert.deepEqual(usage.usedPreloaded, []);
    assert.deepEqual(usage.unusedPreloaded, []);
  });

  test("dedupes and sorts regardless of input order or repeats", () => {
    const usage = summarizeToolSurfaceUsage({
      activeTools: ["contacts.search", "contacts.get", "contacts.search"],
      preloadedTools: ["contacts.search", "contacts.search"],
      kernelTools: KERNEL,
      invokedTools: new Set(["contacts.search"]),
    });

    assert.deepEqual(usage.loaded, ["contacts.get", "contacts.search"]);
    assert.deepEqual(usage.usedLoaded, ["contacts.search"]);
    assert.deepEqual(usage.unusedLoaded, ["contacts.get"]);
  });
});

describe("invokedToolNamesFromTranscript", () => {
  function assistant(
    content: Extract<TranscriptMessage, { role: "assistant" }>["content"],
  ): TranscriptMessage {
    return { role: "assistant", content };
  }

  test("collects dotted tool names from assistant tool-call parts", () => {
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "find my meetings" },
      assistant([
        { type: "text", text: "on it" },
        { type: "tool-call", toolCallId: "c1", toolName: "contacts.get", input: {} },
      ]),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "contacts.get",
            output: { type: "json", value: {} },
          },
        ],
      },
      assistant([
        { type: "tool-call", toolCallId: "c2", toolName: "contacts.search", input: {} },
        { type: "tool-call", toolCallId: "c3", toolName: "contacts.get", input: {} },
      ]),
    ];

    const invoked = invokedToolNamesFromTranscript(transcript);
    assert.deepEqual([...invoked].toSorted(), ["contacts.get", "contacts.search"]);
  });

  test("ignores non-assistant messages, non-tool-call parts, and unregistered names", () => {
    const transcript: TranscriptMessage[] = [
      // a tool-result on a tool message must not count as an invocation
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c8",
            toolName: "contacts.search",
            output: { type: "json", value: {} },
          },
        ],
      },
      assistant("plain string content"),
      assistant([
        { type: "text", text: "no tools here" },
        { type: "tool-call", toolCallId: "c9", toolName: "not_a_real_tool", input: {} },
      ]),
    ];

    assert.equal(invokedToolNamesFromTranscript(transcript).size, 0);
  });
});
