import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createRuntimeAdapterLifecycle,
  registerRuntimeAdapters,
  RUNTIME_ADAPTERS,
  unregisterRuntimeAdapters,
  type RuntimeAdapterDefinition,
} from "../../src/composition/runtime-adapters";

function adapter(
  name: string,
  calls: string[],
  options: Pick<RuntimeAdapterDefinition, "retainIfIngestionWorkerActive" | "shutdownOrder">,
): RuntimeAdapterDefinition {
  return {
    name,
    register: () => calls.push(`register:${name}`),
    unregister: () => calls.push(`unregister:${name}`),
    ...options,
  };
}

describe("runtime adapter lifecycle", () => {
  test("pins the production startup, shutdown, and ingestion-retention policy", () => {
    assert.deepEqual(
      RUNTIME_ADAPTERS.map(({ name }) => name),
      [
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
      ],
    );
    assert.deepEqual(
      RUNTIME_ADAPTERS.filter(({ retainIfIngestionWorkerActive }) =>
        Boolean(retainIfIngestionWorkerActive),
      ).map(({ name }) => name),
      ["chat-media", "gmail-triage", "gmail-user-model", "trigger-consumers", "workflow-readiness"],
    );
  });

  test("registers adapters in manifest order", () => {
    const calls: string[] = [];
    const lifecycle = createRuntimeAdapterLifecycle([
      adapter("first", calls, {
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 2,
      }),
      adapter("second", calls, {
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
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 2,
      }),
      adapter("second", calls, {
        retainIfIngestionWorkerActive: false,
        shutdownOrder: 1,
      }),
    ]);

    lifecycle.unregister({ ingestionWorkerStopped: true });

    assert.deepEqual(calls, ["unregister:second", "unregister:first"]);
  });

  test("retains ingestion adapters when ingestion remains active", () => {
    const calls: string[] = [];
    const lifecycle = createRuntimeAdapterLifecycle([
      adapter("ingestion-first", calls, {
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 1,
      }),
      adapter("runtime", calls, {
        retainIfIngestionWorkerActive: false,
        shutdownOrder: 2,
      }),
      adapter("ingestion-last", calls, {
        retainIfIngestionWorkerActive: true,
        shutdownOrder: 3,
      }),
    ]);

    lifecycle.unregister({ ingestionWorkerStopped: false });

    assert.deepEqual(calls, ["unregister:runtime"]);
  });

  test("aggregate lifecycle remains idempotent", () => {
    assert.doesNotThrow(() => {
      registerRuntimeAdapters();
      registerRuntimeAdapters();
      unregisterRuntimeAdapters({ ingestionWorkerStopped: true });
      unregisterRuntimeAdapters({ ingestionWorkerStopped: true });
    });
  });
});
