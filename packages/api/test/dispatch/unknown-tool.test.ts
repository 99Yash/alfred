import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { undeclaredToolMessage } from "../../src/modules/dispatch";

describe("undeclaredToolMessage", () => {
  test("points bare integration actions at load_integration and the qualified tool name", () => {
    const message = undeclaredToolMessage("list_events");

    assert.match(message, /calendar\.list_events/);
    assert.match(message, /system\.load_integration/);
    assert.match(message, /slug 'calendar'/);
    assert.match(message, /Do not ask the user/);
  });

  test("does not suggest integrations outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("list_events", ["github"]);

    assert.equal(message, "Tool 'list_events' is not declared");
  });

  test("does not suggest an integration for ambiguous bare actions", () => {
    const message = undeclaredToolMessage("batch_update");

    assert.equal(message, "Tool 'batch_update' is not declared");
  });
});
