import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTranscriptMessage, ToolName } from "@alfred/contracts";

import {
  invokedToolNamesFromTranscript,
  summarizeToolSurfaceUsage,
} from "../../src/modules/agent/tool-surface-usage";

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
        "calendar.list_events", // loaded + used
        "gmail.search", // loaded + unused
        "github.search", // loaded + unused
      ],
      preloadedTools: ["calendar.list_events", "gmail.search"],
      kernelTools: KERNEL,
      invokedTools: new Set(["calendar.list_events", "system.current_time"]),
    });

    assert.deepEqual(usage.loaded, ["calendar.list_events", "github.search", "gmail.search"]);
    assert.deepEqual(usage.usedLoaded, ["calendar.list_events"]);
    assert.deepEqual(usage.unusedLoaded, ["github.search", "gmail.search"]);
    assert.deepEqual(usage.preloaded, ["calendar.list_events", "gmail.search"]);
    assert.deepEqual(usage.usedPreloaded, ["calendar.list_events"]);
    assert.deepEqual(usage.unusedPreloaded, ["gmail.search"]);
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
      activeTools: ["gmail.search", "calendar.list_events", "gmail.search"],
      preloadedTools: ["gmail.search", "gmail.search"],
      kernelTools: KERNEL,
      invokedTools: new Set(["gmail.search"]),
    });
    assert.deepEqual(usage.loaded, ["calendar.list_events", "gmail.search"]);
    assert.deepEqual(usage.usedLoaded, ["gmail.search"]);
    assert.deepEqual(usage.unusedLoaded, ["calendar.list_events"]);
  });
});

describe("invokedToolNamesFromTranscript", () => {
  function assistant(content: unknown): AgentTranscriptMessage {
    return { role: "assistant", content };
  }

  test("collects dotted tool names from assistant tool-call parts", () => {
    const transcript: AgentTranscriptMessage[] = [
      { role: "user", content: "find my meetings" },
      assistant([
        { type: "text", text: "on it" },
        { type: "tool-call", toolCallId: "c1", toolName: "calendar.list_events", input: {} },
      ]),
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "calendar.list_events" }],
      },
      assistant([
        { type: "tool-call", toolCallId: "c2", toolName: "gmail.search", input: {} },
        { type: "tool-call", toolCallId: "c3", toolName: "calendar.list_events", input: {} },
      ]),
    ];
    const invoked = invokedToolNamesFromTranscript(transcript);
    assert.deepEqual([...invoked].sort(), ["calendar.list_events", "gmail.search"]);
  });

  test("ignores non-assistant messages, non-tool-call parts, and unregistered names", () => {
    const transcript: AgentTranscriptMessage[] = [
      // a tool-result on a tool message must not count as an invocation
      { role: "tool", content: [{ type: "tool-result", toolName: "gmail.search" }] },
      assistant("plain string content"),
      assistant([
        { type: "text", text: "no tools here" },
        { type: "tool-call", toolCallId: "c9", toolName: "not_a_real_tool", input: {} },
      ]),
    ];
    assert.equal(invokedToolNamesFromTranscript(transcript).size, 0);
  });
});
