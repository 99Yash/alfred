import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { toMessage } from "@alfred/contracts";
import { createAssistantRuntime, runShutdownStep } from "../../src/runtime/runtime";

/**
 * The process-facing door of the assistant runtime, held to three claims.
 *
 * 1. The returned object carries `start` and `stop` and nothing else, so a host
 *    cannot reach a queue, a worker or an adapter by name and cannot reorder the
 *    lifecycle from outside.
 * 2. Building a runtime runs no step. `createAssistantRuntime` reads no
 *    configuration callback and touches no service until `start` is awaited.
 * 3. One failing teardown step does not stop the rest. `stop` iterates every step
 *    through `runShutdownStep`, which swallows, logs and reports `false`; the one
 *    decision that reads the boolean is the ingestion retention rule.
 *
 * What this file does NOT pin is the full start/stop trace. The steps are
 * module-level imports rather than injected dependencies, so a trace fake needs an
 * interface this item did not build. Campaign item 150 owns it.
 */

function neverCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} must not run before start()`);
  };
}

const inertConfig = {
  workerConcurrency: 4,
  registerRecipes: neverCalled("registerRecipes"),
  registerUserCreated: neverCalled("registerUserCreated"),
  assertCredentialsReady: neverCalled("assertCredentialsReady"),
  flushObservability: neverCalled("flushObservability"),
};

describe("assistant runtime door", () => {
  test("exposes exactly start and stop", () => {
    const runtime = createAssistantRuntime(inertConfig);

    assert.deepEqual(Object.keys(runtime).sort(), ["start", "stop"]);
    assert.equal(typeof runtime.start, "function");
    assert.equal(typeof runtime.stop, "function");
  });

  test("construction runs no configuration callback", () => {
    // Every member of `inertConfig` throws. Reaching the assertion at all is the
    // claim: a runtime built at module scope must not start anything.
    assert.doesNotThrow(() => createAssistantRuntime(inertConfig));
  });
});

describe("teardown step policy", () => {
  test("reports a step that finished", async () => {
    let ran = false;
    const finished = await runShutdownStep("worker", async () => {
      ran = true;
    });

    assert.equal(finished, true);
    assert.equal(ran, true);
  });

  test("swallows a rejecting step and reports it did not finish", async () => {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => toMessage(arg)).join(" "));
    };

    try {
      const finished = await runShutdownStep("ingestion worker", () =>
        Promise.reject(new Error("redis gone")),
      );

      assert.equal(finished, false);
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? "", /ingestion worker/);
      assert.match(errors[0] ?? "", /redis gone/);
    } finally {
      console.error = consoleError;
    }
  });
});

describe("runtime package doors", () => {
  const require = createRequire(import.meta.url);

  test("advertises the runtime door and its one test door", () => {
    for (const subpath of ["@alfred/assistant/runtime", "@alfred/assistant/runtime/test-support"]) {
      assert.doesNotThrow(() => require.resolve(subpath), `${subpath} must stay resolvable`);
    }
  });

  test("keeps every runtime adapter private", () => {
    // The adapters are runtime implementation. No manifest key may name one, and
    // none of the four ingestion leaf keys that the moved tests used to need may
    // come back — those tests now live in this package and import relatively.
    const forbidden = [
      "@alfred/assistant/runtime/adapters/runtime-adapters",
      "@alfred/assistant/runtime/adapters/chat-media",
      "@alfred/assistant/runtime/adapters/gmail-triage",
      "@alfred/assistant/runtime/adapters/gmail-user-model",
      "@alfred/assistant/runtime/adapters/gmail-ingested-consumers",
      "@alfred/assistant/runtime/adapters/google-credential-lifecycle",
      "@alfred/assistant/runtime/adapters/trigger-consumers",
      "@alfred/assistant/runtime/adapters/workflow-readiness",
      "@alfred/assistant/runtime/adapters/workflow-recovery",
      "@alfred/assistant/runtime/adapters/chat-attachment-enrichment-adapter",
      "@alfred/assistant/runtime/adapters/replicache-poke-adapter",
      "@alfred/assistant/runtime/runtime",
      "@alfred/assistant/connections/ingestion/queue",
      "@alfred/assistant/connections/ingestion/chat-media",
      "@alfred/assistant/connections/ingestion/gmail-triage",
      "@alfred/assistant/connections/ingestion/gmail-user-model",
    ];

    for (const subpath of forbidden) {
      assert.throws(
        () => require.resolve(subpath),
        `${subpath} must not resolve: it is runtime implementation, not a door`,
      );
    }
  });
});
