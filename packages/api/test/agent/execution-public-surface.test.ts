import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as agentBarrel from "@alfred/assistant/execution";
import * as backendFacade from "../../src/backend";

/**
 * Item 09 removes the raw `createRun` / `enqueueRun` split primitives — and the
 * `enqueueRun as deliverRun` alias — from execution's public surface: the
 * execution module barrel (`@alfred/assistant/execution`) and the
 * `@alfred/api/backend` facade. After the removal a caller outside
 * `packages/assistant/src/execution/` can reach
 * a run only through `startRun` / `startRunInTx` (folded persist+deliver),
 * `redeliverRun` (deliver an already-persisted run), or — barrel-only, for the
 * chat-turn savepoint — `persistChatTurnRunInTx`. It can no longer persist a run
 * without delivering it or obtain the raw BullMQ queue handle.
 *
 * This is the machine form of the item's deletion-test grep: it fails if any
 * later change re-exports the removed pair through either public seam. The
 * primitives themselves stay defined and exported from their own subfiles for
 * in-module callers and white-box tests, so this asserts the *public surface*,
 * not the primitives' existence.
 */
describe("execution public run-start surface (item 09)", () => {
  // Cast to a string-indexed record so absence checks read a runtime key rather
  // than a statically-known export (which would be a compile error to name).
  const asRecord = (m: object): Record<string, unknown> => m as Record<string, unknown>;

  const FOLDED_AND_NARROW = ["startRun", "startRunInTx", "redeliverRun"] as const;
  const REMOVED_PAIR = ["createRun", "enqueueRun", "deliverRun"] as const;

  test("agent barrel exposes the folded + narrow ops, not the raw create/enqueue pair", () => {
    const barrel = asRecord(agentBarrel);
    for (const name of [...FOLDED_AND_NARROW, "persistChatTurnRunInTx"]) {
      assert.equal(typeof barrel[name], "function", `barrel must export ${name}`);
    }
    for (const name of REMOVED_PAIR) {
      assert.equal(barrel[name], undefined, `barrel must NOT re-export ${name}`);
    }
  });

  test("@alfred/api/backend facade exposes the folded + re-delivery ops, not the raw pair", () => {
    const facade = asRecord(backendFacade);
    for (const name of FOLDED_AND_NARROW) {
      assert.equal(typeof facade[name], "function", `facade must export ${name}`);
    }
    for (const name of REMOVED_PAIR) {
      assert.equal(facade[name], undefined, `facade must NOT re-export ${name}`);
    }
    // `persistChatTurnRunInTx` is barrel-only: conversations lives in `@alfred/api`
    // and imports the barrel, while the facade serves `apps/server`, which has no
    // chat-turn savepoint caller.
    assert.equal(
      facade["persistChatTurnRunInTx"],
      undefined,
      "facade must NOT export the barrel-only persistChatTurnRunInTx",
    );
  });
});
