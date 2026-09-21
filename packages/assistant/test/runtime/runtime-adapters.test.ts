import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createRuntimeAdapterLifecycle,
  registerRuntimeAdapters,
  RUNTIME_ADAPTERS,
  unregisterRuntimeAdapters,
  type RuntimeAdapterDefinition,
} from "../../src/runtime/adapters/runtime-adapters";
import { runShutdownStep } from "../../src/runtime/runtime";
import {
  registerSystemToolAgentAdapter,
  registerSystemToolChatHistoryAdapter,
  registerSystemToolInstructionAdapter,
  registerSystemToolKnowledgeAdapter,
  registerSystemToolTaskAdapter,
  registerSystemToolWebSearchAdapter,
  registerSystemToolWorkflowAdapter,
  type SystemToolAgentAdapter,
  type SystemToolChatHistoryAdapter,
  type SystemToolInstructionAdapter,
  type SystemToolKnowledgeAdapter,
  type SystemToolTaskAdapter,
  type SystemToolWebSearchAdapter,
  type SystemToolWorkflowAdapter,
} from "../../src/tool-runtime";

function adapter(
  name: string,
  calls: string[],
  options: Pick<
    RuntimeAdapterDefinition,
    "retainIfAgentWorkerActive" | "retainIfIngestionWorkerActive" | "shutdownOrder"
  >,
): RuntimeAdapterDefinition {
  return {
    name,
    register: () => calls.push(`register:${name}`),
    unregister: () => calls.push(`unregister:${name}`),
    ...options,
  };
}

describe("runtime adapter lifecycle", () => {
  test("pins the production startup, shutdown, and worker-retention policy", () => {
    assert.deepEqual(
      RUNTIME_ADAPTERS.map(({ name }) => name),
      [
        "system-tool-agent",
        "system-tool-chat",
        "system-tool-workflows",
        "system-tool-product",
        "system-tool-context-search",
        "chat-attachment-enrichment",
        "chat-media",
        "gmail-triage",
        "gmail-user-model",
        "google-credential-lifecycle",
        "replicache-poke-adapter",
        "trigger-consumers",
        "workflow-recovery",
        "workflow-readiness",
      ],
    );
    assert.deepEqual(
      [...RUNTIME_ADAPTERS]
        .sort((left, right) => left.shutdownOrder - right.shutdownOrder)
        .map(({ name }) => name),
      [
        "trigger-consumers",
        "chat-media",
        "gmail-triage",
        "gmail-user-model",
        "google-credential-lifecycle",
        "workflow-recovery",
        "workflow-readiness",
        "replicache-poke-adapter",
        "chat-attachment-enrichment",
        "system-tool-product",
        "system-tool-workflows",
        "system-tool-chat",
        "system-tool-agent",
        "system-tool-context-search",
      ],
    );
    assert.deepEqual(
      RUNTIME_ADAPTERS.filter(({ retainIfAgentWorkerActive }) =>
        Boolean(retainIfAgentWorkerActive),
      ).map(({ name }) => name),
      [
        "system-tool-agent",
        "system-tool-chat",
        "system-tool-workflows",
        "system-tool-product",
        "system-tool-context-search",
      ],
    );
    assert.deepEqual(
      RUNTIME_ADAPTERS.filter(({ retainIfIngestionWorkerActive }) =>
        Boolean(retainIfIngestionWorkerActive),
      ).map(({ name }) => name),
      [
        "chat-attachment-enrichment",
        "chat-media",
        "gmail-triage",
        "gmail-user-model",
        "trigger-consumers",
        "workflow-readiness",
      ],
    );
  });

  test("registers adapters in manifest order", () => {
    const calls: string[] = [];

    const lifecycle = createRuntimeAdapterLifecycle([
      adapter("first", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 2,
      }),
      adapter("second", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: false,
        shutdownOrder: 1,
      }),
    ]);

    lifecycle.register();

    assert.deepEqual(calls, ["register:first", "register:second"]);
  });

  test("unregisters every adapter in declared shutdown order after ingestion stops", () => {
    const calls: string[] = [];

    const lifecycle = createRuntimeAdapterLifecycle([
      adapter("first", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 2,
      }),
      adapter("second", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: false,
        shutdownOrder: 1,
      }),
    ]);

    lifecycle.unregister({ agentWorkerStopped: true, ingestionWorkerStopped: true });

    assert.deepEqual(calls, ["unregister:second", "unregister:first"]);
  });

  test("retains ingestion adapters when ingestion remains active", () => {
    const calls: string[] = [];

    const lifecycle = createRuntimeAdapterLifecycle([
      adapter("ingestion-first", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 1,
      }),
      adapter("runtime", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: false,
        shutdownOrder: 2,
      }),
      adapter("ingestion-last", calls, {
        retainIfAgentWorkerActive: false,
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 3,
      }),
    ]);

    lifecycle.unregister({ agentWorkerStopped: true, ingestionWorkerStopped: false });

    assert.deepEqual(calls, ["unregister:runtime"]);
  });

  test("retains every real system-tool port when agent worker stop rejects", async () => {
    registerRuntimeAdapters();
    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      const agentWorkerStopped = await runShutdownStep("agent worker", () =>
        Promise.reject(new Error("worker close failed")),
      );

      unregisterRuntimeAdapters({ agentWorkerStopped, ingestionWorkerStopped: true });

      const agent: SystemToolAgentAdapter = {
        spawnSubAgent: () =>
          Promise.resolve({
            ok: true,
            status: "spawned",
            parentRunId: "run_parent",
            childRunId: "run_child",
            subId: "sub_1",
          } as const),
        readChildRunOutcome: () =>
          Promise.resolve({ ok: true, done: true, status: "completed" } as const),
        resolveAwaitSubAgent: () =>
          Promise.resolve({
            kind: "executed",
            stagingId: null,
            toolResult: null,
            editedByUser: false,
          }),
        readScratch: () => Promise.resolve(null),
        writeScratch: () => Promise.resolve(undefined),
        promoteScratch: () => Promise.resolve(null),
      };

      const chat: SystemToolChatHistoryAdapter = {
        readChatHistory: () =>
          Promise.resolve({
            ok: true,
            mode: "fetch",
            found: false,
            kind: "message",
            id: "x",
          } as const),
      };

      const workflows: SystemToolWorkflowAdapter = {
        authorWorkflow: () =>
          Promise.resolve({
            ok: false,
            status: "not_found",
            failure: { kind: "not_found" },
          } as const),
        recoverWorkflow: () =>
          Promise.resolve({
            ok: false,
            status: "not_found",
            failure: { kind: "not_found" },
          } as const),
        activateWorkflow: () =>
          Promise.resolve({
            ok: false,
            status: "not_found",
            failure: { kind: "not_found" },
          } as const),
      };

      const knowledge: SystemToolKnowledgeAdapter = {
        readUserContext: () =>
          Promise.resolve({
            profile: null,
            activeIntegrations: [],
            confirmedFacts: [],
            preferences: [],
            entities: [],
            relations: [],
            recentMemory: [],
          } as const),
      };

      const instructions: SystemToolInstructionAdapter = {
        rememberSenderSuppressionAndDismissTodos: () =>
          Promise.resolve({
            ok: false,
            status: "needs_clarification",
            reason: "invalid_sender_email",
            message: "not an email address",
          } as const),
        listInstructions: () =>
          Promise.resolve({
            instructions: [],
            totalActive: 0,
            truncated: false,
            limit: 50,
          } as const),
        forgetInstruction: () => Promise.resolve({ ok: false, status: "not_found" } as const),
        editInstruction: () => Promise.resolve({ ok: false, status: "not_found" } as const),
      };

      const search: SystemToolWebSearchAdapter = {
        webSearch: () =>
          Promise.resolve({
            ok: true,
            query: "q",
            answer: "a",
            citations: [],
            results: [],
            searchQueries: ["q"],
          } as const),
      };

      const tasks: SystemToolTaskAdapter = {
        resolveTodo: () =>
          Promise.resolve({
            ok: true,
            status: "dismissed",
            dismissedCount: 0,
            todoIds: [],
            matchedThreadIds: [],
            auditReason: null,
          } as const),
        suggestTodo: () =>
          Promise.resolve({ ok: true, status: "created", todoId: "todo_1" } as const),
      };

      for (const install of [
        () => registerSystemToolAgentAdapter(agent),
        () => registerSystemToolChatHistoryAdapter(chat),
        () => registerSystemToolWorkflowAdapter(workflows),
        () => registerSystemToolKnowledgeAdapter(knowledge),
        () => registerSystemToolInstructionAdapter(instructions),
        () => registerSystemToolWebSearchAdapter(search),
        () => registerSystemToolTaskAdapter(tasks),
      ]) {
        assert.throws(install, /already registered/);
      }

      assert.equal(agentWorkerStopped, false);
      assert.equal(errors.length, 1);
    } finally {
      console.error = consoleError;
      unregisterRuntimeAdapters({ agentWorkerStopped: true, ingestionWorkerStopped: true });
    }
  });

  test("aggregate lifecycle remains idempotent", () => {
    assert.doesNotThrow(() => {
      registerRuntimeAdapters();
      registerRuntimeAdapters();
      unregisterRuntimeAdapters({ agentWorkerStopped: true, ingestionWorkerStopped: true });
      unregisterRuntimeAdapters({ agentWorkerStopped: true, ingestionWorkerStopped: true });
    });
  });
});
