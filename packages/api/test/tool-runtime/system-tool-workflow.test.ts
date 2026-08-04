import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  activateWorkflow,
  authorWorkflow,
  recoverWorkflow,
  registerSystemToolWorkflowAdapter,
  type SystemToolWorkflowAdapter,
} from "../../src/modules/tool-runtime";

// The seam owns no behavior: it forwards each op to the registered adapter and
// returns its result unchanged. These tests pin exactly that — a missing
// registration fails loud, a registered adapter receives the exact args and its
// result is handed straight back. The adapter never inspects the input, so a
// minimal placeholder stands in for a fully-parsed workflow input here.
const authorArgs = {
  userId: "user_1",
  runId: "run_1",
  timezone: "America/New_York",
  input: { name: "Inbox summary" },
} as unknown as Parameters<typeof authorWorkflow>[0];
const recoverArgs = { userId: "user_1", workflowId: "wf_1", revisionId: "rev_1" };
const activateArgs = {
  userId: "user_1",
  input: { workflowId: "wf_1" },
  createdByRunId: "run_1",
} as unknown as Parameters<typeof activateWorkflow>[0];

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("system-tool workflow seam without a registered adapter", () => {
  test("each delegating op throws the boot-order error", () => {
    const message = "No system-tool workflow adapter is registered";
    assert.throws(() => authorWorkflow(authorArgs), { message });
    assert.throws(() => recoverWorkflow(recoverArgs), { message });
    assert.throws(() => activateWorkflow(activateArgs), { message });
  });
});

describe("system-tool workflow seam with a registered adapter", () => {
  test("forwards each op's args verbatim and returns its result unchanged", async () => {
    const seen: {
      author?: typeof authorArgs;
      recover?: typeof recoverArgs;
      activate?: typeof activateArgs;
    } = {};
    const authorResult = { ok: true, status: "ready_to_activate" };
    const recoverResult = { ok: true, status: "blocked" };
    const activateResult = { ok: true, status: "activated" };
    const adapter: SystemToolWorkflowAdapter = {
      authorWorkflow: (args) => {
        seen.author = args;
        return Promise.resolve(authorResult);
      },
      recoverWorkflow: (args) => {
        seen.recover = args;
        return Promise.resolve(recoverResult);
      },
      activateWorkflow: (args) => {
        seen.activate = args;
        return Promise.resolve(activateResult);
      },
    };
    unregister = registerSystemToolWorkflowAdapter(adapter);

    // Same object identity out as the adapter returned — the seam adds nothing.
    assert.equal(await authorWorkflow(authorArgs), authorResult);
    assert.equal(await recoverWorkflow(recoverArgs), recoverResult);
    assert.equal(await activateWorkflow(activateArgs), activateResult);

    // Same object identity in — the seam forwards, it does not reshape.
    assert.equal(seen.author, authorArgs);
    assert.equal(seen.recover, recoverArgs);
    assert.equal(seen.activate, activateArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const first: SystemToolWorkflowAdapter = {
      authorWorkflow: () => Promise.resolve(null),
      recoverWorkflow: () => Promise.resolve(null),
      activateWorkflow: () => Promise.resolve(null),
    };
    unregister = registerSystemToolWorkflowAdapter(first);
    assert.throws(() => registerSystemToolWorkflowAdapter({ ...first }), {
      message: "A system-tool workflow adapter is already registered",
    });
    // Re-registering the SAME adapter is idempotent, not an error.
    assert.doesNotThrow(() => registerSystemToolWorkflowAdapter(first));
  });
});
