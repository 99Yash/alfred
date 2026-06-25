import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { undeclaredToolMessage } from "../../src/modules/dispatch";

describe("undeclaredToolMessage", () => {
  test("points bare integration actions at load_integration and the qualified tool name", () => {
    const message = undeclaredToolMessage("list_events");

    assert.match(message, /calendar\.list_events/);
    assert.match(message, /calendar exposes: `list_events`, `create_event`/);
    assert.match(message, /system\.load_integration/);
    assert.match(message, /slug 'calendar'/);
    assert.match(message, /Do not ask the user/);
  });

  test("enumerates valid actions for an invented qualified integration tool", () => {
    const message = undeclaredToolMessage("github.list_pull_requests", ["github"]);

    assert.match(message, /github exposes: `search`, `get_pull_request`, `get_issue`/);
    // An invented `list_*` tool wants to enumerate; the recovery hint must point
    // at `search` (which can list), not `get_pull_request` (needs a known PR #).
    assert.match(message, /Use 'github\.search' instead/);
    assert.match(message, /system\.load_integration/);
  });

  test("does not suggest integrations outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("list_events", ["github"]);

    assert.equal(message, "Tool 'list_events' is not declared");
  });

  test("does not enumerate qualified tools outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("calendar.read_events", ["github"]);

    assert.equal(message, "Tool 'calendar.read_events' is not declared");
  });

  test("does not suggest an integration for ambiguous bare actions", () => {
    const message = undeclaredToolMessage("batch_update");

    assert.equal(message, "Tool 'batch_update' is not declared");
  });
});
