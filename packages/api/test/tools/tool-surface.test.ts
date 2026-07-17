import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { isToolName, type ToolName } from "@alfred/contracts";
import { buildChatSystemPrompt } from "../../src/modules/agent/workflows/chat-turn";
import {
  applyExactToolLoad,
  applySystemToolEffect,
  buildSdkToolSet,
  migrateActiveTools,
  registeredToolNamesForIntegrations,
  systemToolKernel,
} from "../../src/modules/agent/tool-surface";
import { preloadToolCatalog, type ToolCatalogAccess } from "../../src/modules/tools/discovery";
import type { ToolAvailabilityResult } from "../../src/modules/integrations/availability";
import { registerBuiltinTools } from "../../src/modules/tools/index";
import {
  clearToolRegistryForTests,
  getTool,
  listKernelTools,
  listToolsForIntegration,
} from "../../src/modules/tools/registry";

/**
 * Regression coverage for the run-local tool surface + persisted-state
 * migration (#405/#411/#412). The load-bearing property: a run checkpointed
 * before a deploy — whose active or pending set may still name a tool that has
 * since been retired (here `system.load_integration`, dropped when
 * integration-level loading was replaced by exact `system.load_tool`) —
 * migrates forward gracefully by DROPPING the unknown name rather than carrying
 * a dangling tool the dispatcher can no longer resolve.
 */

// A plausibly-persisted name that is no longer a registered tool: not present in
// INTEGRATION_ACTIONS['system'], so `isToolName` rejects it before the registry
// lookup even runs.
const RETIRED_TOOL = "system.load_integration";

before(() => {
  clearToolRegistryForTests();
  registerBuiltinTools();
});

after(() => clearToolRegistryForTests());

describe("systemToolKernel", () => {
  test("mirrors the registered kernel surface and every entry is a kernel system tool", () => {
    const kernel = systemToolKernel();
    assert.ok(kernel.length > 0, "kernel must be non-empty");
    assert.deepEqual(
      [...kernel].sort(),
      listKernelTools()
        .map((tool) => tool.name)
        .sort(),
    );
    for (const name of kernel) {
      const tool = getTool(name);
      assert.ok(tool, `kernel tool ${name} must be registered`);
      assert.equal(tool?.integration, "system");
      assert.equal(tool?.availability?.surface, "kernel");
    }
  });

  test("every system tool named by the composed chat prompt is eager or intentionally lazy", () => {
    // Artifact mutation schemas are intentionally the largest system tools, so
    // they stay lazy even when the prompt explains the artifact workflow. Any
    // other newly named system tool must be promoted or deliberately added here.
    const intentionallyLazy = new Set<ToolName>([
      "system.create_artifact",
      "system.append_artifact_page",
      "system.append_artifact_section",
      "system.update_artifact",
    ]);
    const prompt = buildChatSystemPrompt("Thursday, July 16, 2026", "", {
      artifactsContext:
        "An artifact is selected. For an edit, use system.update_artifact on the selected id.",
    });
    const namedSystemTools = new Set(prompt.match(/\bsystem\.[a-z_]+\b/g) ?? []);
    const kernel = new Set<string>(systemToolKernel());

    for (const name of namedSystemTools) {
      assert.ok(isToolName(name), `prompt-named tool ${name} must be a canonical tool name`);
      assert.ok(getTool(name), `prompt-named tool ${name} must be registered`);
      assert.ok(
        kernel.has(name) || intentionallyLazy.has(name),
        `prompt-named tool ${name} must be kernel or explicitly intentionally lazy`,
      );
    }
    assert.ok(namedSystemTools.has("system.await_sub_agent"));
    assert.ok(kernel.has("system.await_sub_agent"));
  });
});

describe("buildSdkToolSet caller/thread projection", () => {
  // The kernel is one set of names; what actually reaches the model is filtered
  // by caller (boss vs sub_agent) and whether the run has a thread. The ladder
  // tools (search_tools/load_tool) must survive EVERY projection — they are the
  // only route to any non-preloaded capability, so a caller that lost them
  // could never climb to a tool it needs.
  const kernelNames = () => listKernelTools().map((t) => t.name);

  test("chat (boss + thread) projects all eight kernel tools", () => {
    const chat = Object.keys(buildSdkToolSet(kernelNames(), { caller: "boss", hasThread: true }));
    assert.equal(chat.length, 8, `[${[...chat].sort().join(", ")}]`);
  });

  test("a thread-less brief drops read_chat_history (requiresThread) → seven", () => {
    const brief = Object.keys(buildSdkToolSet(kernelNames(), { caller: "boss", hasThread: false }));
    assert.equal(brief.length, 7);
    assert.ok(!brief.includes("system.read_chat_history"), `[${[...brief].sort().join(", ")}]`);
  });

  test("a sub-agent also drops spawn_sub_agent (boss-only caller) → five", () => {
    const sub = Object.keys(
      buildSdkToolSet(kernelNames(), { caller: "sub_agent", hasThread: false }),
    );
    assert.equal(sub.length, 5);
    assert.ok(!sub.includes("system.read_chat_history"));
    assert.ok(!sub.includes("system.spawn_sub_agent"), `[${[...sub].sort().join(", ")}]`);
  });

  test("the ladder (search_tools + load_tool) is projected in every context", () => {
    for (const context of [
      { caller: "boss", hasThread: true },
      { caller: "boss", hasThread: false },
      { caller: "sub_agent", hasThread: false },
    ] as const) {
      const names = Object.keys(buildSdkToolSet(kernelNames(), context));
      assert.ok(
        names.includes("system.search_tools") && names.includes("system.load_tool"),
        `ladder missing for ${JSON.stringify(context)}: [${[...names].sort().join(", ")}]`,
      );
    }
  });
});

describe("preloadToolCatalog against the real registry", () => {
  // Path B (deterministic preload) vs path C (the model must climb the ladder).
  // discovery.test.ts covers the mechanics with mock tools; this pins them
  // against the REAL github discovery metadata, where the nuance bites:
  // `github.search`'s entity phrase is the singular "pull request", so a
  // word-boundary match on the plural "pull requests" misses it and the ask
  // falls through to the ladder rather than preloading.
  const githubAccess = (): { access: ToolCatalogAccess; kernelNames: ToolName[] } => {
    const kernelNames = listKernelTools().map((t) => t.name);
    const githubNames = listToolsForIntegration("github").map((t) => t.name);
    return {
      kernelNames,
      access: {
        allowedIntegrations: ["github"],
        availability: new Map<ToolName, ToolAvailabilityResult>(
          [...kernelNames, ...githubNames].map((name) => [name, { available: true }]),
        ),
      },
    };
  };

  test("a strong-intent prompt preloads a non-kernel github tool (path B)", () => {
    const { access, kernelNames } = githubAccess();
    const selected = preloadToolCatalog({
      prompt: "find the pull request assigned to me",
      activeTools: kernelNames,
      access,
    });
    assert.ok(selected.length > 0, "expected at least one preloaded tool");
    assert.ok(
      selected.every((n) => n.startsWith("github.")),
      `selected [${selected.join(", ")}]`,
    );
  });

  test("a github-relevant but loosely phrased ask preloads nothing → ladder only (path C)", () => {
    const { access, kernelNames } = githubAccess();
    const selected = preloadToolCatalog({
      prompt: "give me a summary of my github activity",
      activeTools: kernelNames,
      access,
    });
    assert.deepEqual(selected, [], `selected [${selected.join(", ")}]`);
  });

  test("a kernel tool is never re-preloaded (already active)", () => {
    const { access, kernelNames } = githubAccess();
    const selected = preloadToolCatalog({
      prompt: "what do you know about me? read my user context",
      activeTools: kernelNames,
      access,
    });
    assert.ok(
      !selected.includes("system.read_user_context" as ToolName),
      `[${selected.join(", ")}]`,
    );
  });
});

describe("migrateActiveTools", () => {
  test("new-format checkpoint drops a retired tool and keeps + sorts the rest", () => {
    const migrated = migrateActiveTools(
      [RETIRED_TOOL, "system.load_tool", "gmail.search"],
      undefined,
      [],
    );
    assert.deepEqual(migrated, ["gmail.search", "system.load_tool"]);
    assert.ok(!(migrated as string[]).includes(RETIRED_TOOL));
  });

  test("new-format checkpoint dedupes repeated names", () => {
    const migrated = migrateActiveTools(
      ["gmail.search", "gmail.search", "system.load_tool"],
      undefined,
      [],
    );
    assert.deepEqual(migrated, ["gmail.search", "system.load_tool"]);
  });

  test("an empty new-format checkpoint is authoritative — it does not re-seed the kernel", () => {
    assert.deepEqual(migrateActiveTools([], undefined, []), []);
  });

  test("legacy expansion drops a retired pending name but keeps kernel + integration tools", () => {
    const migrated = migrateActiveTools(undefined, ["gmail"], [RETIRED_TOOL]);
    assert.ok(!(migrated as string[]).includes(RETIRED_TOOL), "retired pending name is dropped");
    for (const name of systemToolKernel()) {
      assert.ok(migrated.includes(name), `kernel tool ${name} retained`);
    }
    for (const name of registeredToolNamesForIntegrations(["gmail"])) {
      assert.ok(migrated.includes(name), `gmail tool ${name} retained`);
    }
  });

  test("legacy expansion never treats system as an eager integration", () => {
    const migrated = migrateActiveTools(undefined, ["system"], []);
    assert.deepEqual(migrated, systemToolKernel());
  });

  test("legacy expansion unions a valid pending tool from outside the active integrations", () => {
    const migrated = migrateActiveTools(undefined, ["gmail"], ["calendar.list_events"]);
    assert.ok(migrated.includes("calendar.list_events"));
  });

  test("empty legacy state yields exactly the kernel", () => {
    const migrated = migrateActiveTools(undefined, undefined, []);
    assert.deepEqual([...migrated].sort(), [...systemToolKernel()].sort());
  });
});

describe("applyExactToolLoad", () => {
  const base: ToolName[] = ["gmail.search"];

  test("adds a valid loaded tool", () => {
    assert.deepEqual(applyExactToolLoad(base, { ok: true, name: "calendar.list_events" }), [
      "calendar.list_events",
      "gmail.search",
    ]);
  });

  test("ignores a retired tool name that is unknown to the registry", () => {
    assert.deepEqual(applyExactToolLoad(base, { ok: true, name: RETIRED_TOOL }), ["gmail.search"]);
  });

  test("ignores a non-ok or malformed effect", () => {
    assert.deepEqual(applyExactToolLoad(base, { ok: false, name: "calendar.list_events" }), [
      "gmail.search",
    ]);
    assert.deepEqual(applyExactToolLoad(base, "nope"), ["gmail.search"]);
    assert.deepEqual(applyExactToolLoad(base, null), ["gmail.search"]);
  });
});

describe("applySystemToolEffect", () => {
  test("a successful load_tool folds the new tool into the active set", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.load_tool", {
      kind: "executed",
      toolResult: { ok: true, name: "calendar.list_events" },
    });
    assert.ok(state.activeTools.includes("calendar.list_events"));
  });

  test("a load_tool naming a retired tool leaves the active set unchanged", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.load_tool", {
      kind: "executed",
      toolResult: { ok: true, name: RETIRED_TOOL },
    });
    assert.deepEqual(state.activeTools, ["gmail.search"]);
  });

  test("a non-load system tool is inert", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.current_time", {
      kind: "executed",
      toolResult: { some: "snapshot" },
    });
    assert.deepEqual(state.activeTools, ["gmail.search"]);
  });

  test("a non-executed load_tool result is inert", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.load_tool", {
      kind: "staged",
      toolResult: { ok: true, name: "calendar.list_events" },
    });
    assert.deepEqual(state.activeTools, ["gmail.search"]);
  });
});
