import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import {
  RUNTIME_TOOL_SURFACE,
  _setRuntimeSpanStarterForTests,
  buildToolSurfaceSpanInput,
  startToolSurfaceSpan,
} from "../../src/modules/agent/runtime-spans";
import { buildTurnToolSurface, systemToolKernel } from "../../src/modules/agent/tool-surface";
import { registerBuiltinTools } from "../../src/modules/tools";

function capture(run: () => void): { opened: RuntimeSpanInput[]; ended: RuntimeSpanEndArgs[] } {
  const opened: RuntimeSpanInput[] = [];
  const ended: RuntimeSpanEndArgs[] = [];
  const restore = _setRuntimeSpanStarterForTests((input) => {
    opened.push(input);
    return { end: (args) => ended.push(args) };
  });
  try {
    run();
  } finally {
    restore();
  }
  return { opened, ended };
}

describe("runtime.tool_surface", () => {
  before(() => registerBuiltinTools());

  const args = {
    runId: "run_surface",
    workflow: "__chat-turn__",
    caller: "boss",
    startedAt: new Date("2026-07-16T00:00:00.000Z"),
  };

  test("opens with only bounded context, never tool schemas", () => {
    const input = buildToolSurfaceSpanInput(args);
    assert.equal(input.name, RUNTIME_TOOL_SURFACE);
    assert.equal(input.name, "runtime.tool_surface");
    assert.equal(input.runId, "run_surface");
    assert.equal(input.startedAt, args.startedAt);
    assert.deepEqual(input.metadata, { workflow: "__chat-turn__", caller: "boss" });
    assert.equal(input.input, undefined);
  });

  test("records the kernel/loaded split, loaded names, payload size, and rebuild health", () => {
    const { opened, ended } = capture(() => {
      startToolSurfaceSpan(args).end({
        activeCount: 10,
        kernelCount: 8,
        loadedCount: 2,
        loadedTools: ["calendar.get_event", "calendar.list_events"],
        schemaBytes: 7878,
        schemaTokens: 1970,
        schemaRebuildMs: 3,
      });
    });
    assert.equal(opened.length, 1);
    assert.deepEqual(ended, [
      {
        status: "measured",
        metadata: {
          activeCount: 10,
          kernelCount: 8,
          loadedCount: 2,
          loadedTools: "calendar.get_event,calendar.list_events",
          schemaBytes: 7878,
          schemaTokens: 1970,
          schemaRebuildMs: 3,
          schemaRebuildHealth: "ok",
        },
      },
    ]);
  });

  test("a kernel-only turn reports no loaded tools", () => {
    const { ended } = capture(() =>
      startToolSurfaceSpan(args).end({
        activeCount: 8,
        kernelCount: 8,
        loadedCount: 0,
        loadedTools: [],
        schemaBytes: 5900,
        schemaTokens: 1475,
        schemaRebuildMs: 1,
      }),
    );
    assert.equal(ended[0]?.metadata?.loadedCount, 0);
    assert.equal(ended[0]?.metadata?.loadedTools, null);
  });

  test("a slow cold rebuild degrades the health band", () => {
    const { ended } = capture(() =>
      startToolSurfaceSpan(args).end({
        activeCount: 40,
        kernelCount: 8,
        loadedCount: 32,
        loadedTools: ["gmail.search"],
        schemaBytes: 40_000,
        schemaTokens: 10_000,
        schemaRebuildMs: 250,
      }),
    );
    assert.equal(ended[0]?.metadata?.schemaRebuildHealth, "red");
  });

  test("error closes once and suppresses a later end", () => {
    const { ended } = capture(() => {
      const span = startToolSurfaceSpan(args);
      span.error();
      span.end({
        activeCount: 8,
        kernelCount: 8,
        loadedCount: 0,
        loadedTools: [],
        schemaBytes: 1,
        schemaTokens: 1,
        schemaRebuildMs: 0,
      });
    });
    assert.deepEqual(ended, [{ status: "error", level: "ERROR" }]);
  });

  test("a real turn surface reports the actual projected registry tools", () => {
    const activeTools = [...systemToolKernel(), "calendar.list_events" as const];
    let returnedToolNames: string[] = [];
    const { opened, ended } = capture(() => {
      returnedToolNames = Object.keys(
        buildTurnToolSurface({
          activeTools,
          context: { caller: "boss", hasThread: true },
          runId: "run_real_surface",
          workflow: "__chat-turn__",
          spanCaller: "boss",
        }),
      ).sort();
    });

    assert.ok(returnedToolNames.includes("calendar.list_events"));
    assert.equal(opened[0]?.name, RUNTIME_TOOL_SURFACE);
    assert.equal(ended[0]?.metadata?.activeCount, returnedToolNames.length);
    assert.equal(ended[0]?.metadata?.kernelCount, returnedToolNames.length - 1);
    assert.equal(ended[0]?.metadata?.loadedCount, 1);
    assert.equal(ended[0]?.metadata?.loadedTools, "calendar.list_events");
    assert.ok(Number(ended[0]?.metadata?.schemaBytes) > 0);
    assert.ok(Number(ended[0]?.metadata?.schemaTokens) > 0);
  });
});
