import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { parseIanaTimezone } from "@alfred/contracts";
import {
  activateWorkflow,
  authorWorkflow,
  recoverWorkflow,
  registerSystemToolWorkflowAdapter,
  type SystemToolWorkflowAdapter,
} from "@alfred/assistant/tool-runtime";

import { asTestDouble } from "../support/test-double";

type AuthorArgs = Parameters<typeof authorWorkflow>[0];

type ActivateArgs = Parameters<typeof activateWorkflow>[0];

// The seam only forwards to the registered adapter and reads no `input` field, so placeholder inputs are enough.
const authorArgs: AuthorArgs = {
  userId: "user_1",
  runId: "run_1",
  timezone: parseIanaTimezone("America/New_York"),
  input: asTestDouble<AuthorArgs["input"]>({ name: "Inbox summary" }),
};

const recoverArgs = { userId: "user_1", workflowId: "wf_1", revisionId: "rev_1" };

const activateArgs: ActivateArgs = {
  userId: "user_1",
  input: asTestDouble<ActivateArgs["input"]>({ workflowId: "wf_1" }),
  createdByRunId: "run_1",
};

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
    interface SeenOps {
      author?: typeof authorArgs;
      recover?: typeof recoverArgs;
      activate?: typeof activateArgs;
    }

    const seen: SeenOps = {};

    const authorResult = {
      ok: false,
      status: "not_found",
      failure: { kind: "not_found" },
    } as const;

    const recoverResult = {
      ok: false,
      status: "not_found",
      failure: { kind: "not_found" },
    } as const;

    const activateResult = {
      ok: false,
      status: "not_found",
      failure: { kind: "not_found" },
    } as const;

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

    assert.equal(await authorWorkflow(authorArgs), authorResult);
    assert.equal(await recoverWorkflow(recoverArgs), recoverResult);
    assert.equal(await activateWorkflow(activateArgs), activateResult);

    assert.equal(seen.author, authorArgs);
    assert.equal(seen.recover, recoverArgs);
    assert.equal(seen.activate, activateArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const notFound = { ok: false, status: "not_found", failure: { kind: "not_found" } } as const;

    const first: SystemToolWorkflowAdapter = {
      authorWorkflow: () => Promise.resolve(notFound),
      recoverWorkflow: () => Promise.resolve(notFound),
      activateWorkflow: () => Promise.resolve(notFound),
    };

    unregister = registerSystemToolWorkflowAdapter(first);
    assert.throws(() => registerSystemToolWorkflowAdapter({ ...first }), {
      message: "A system-tool workflow adapter is already registered",
    });
    assert.doesNotThrow(() => registerSystemToolWorkflowAdapter(first));
  });
});
