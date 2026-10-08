import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { undeclaredToolMessage } from "../../../src/tool-runtime/internal/dispatch";

describe("undeclaredToolMessage", () => {
  test("points bare integration actions at exact loading and the qualified tool name", () => {
    const message = undeclaredToolMessage("list_events");

    assert.match(message, /calendar\.list_events/);
    assert.match(message, /calendar exposes: `list_events`, `create_event`/);
    assert.match(message, /system\.load_tool/);
    assert.match(message, /name 'calendar\.list_events'/);
    assert.match(message, /Do not ask the user/);
  });

  test("enumerates valid actions for an invented qualified integration tool", () => {
    const message = undeclaredToolMessage("github.list_pull_requests", ["github"]);

    assert.match(
      message,
      /github exposes: `search`, `get_pull_request`, `get_pull_requests`, `get_issue`/,
    );
    // A `list_*` guess wants to enumerate, so point at `search`, not `get_pull_request`.
    assert.match(message, /Use 'github\.search' instead/);
    assert.match(message, /system\.load_tool/);
  });

  test("does not suggest integrations outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("list_events", ["github"]);

    assert.equal(message, "Tool 'list_events' is not declared");
  });

  test("does not enumerate qualified tools outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("calendar.read_events", ["github"]);

    assert.equal(message, "Tool 'calendar.read_events' is not declared");
  });

  test("recovers a bare integration slug (the boss mistook the integration for a tool)", () => {
    // No `system.load_tool` here: search activates its top hit, and other tools activate on
    // first call.
    const message = undeclaredToolMessage("calendar");

    assert.match(message, /calendar exposes: `list_events`, `create_event`/);
    assert.match(message, /system\.search_tools for 'calendar'/);
    assert.doesNotMatch(message, /system\.load_tool/);
    assert.match(message, /Do not ask the user/);
  });

  test("does not recover a bare integration slug outside a workflow allowlist", () => {
    assert.equal(undeclaredToolMessage("calendar", ["github"]), "Tool 'calendar' is not declared");
  });

  test("does not suggest an integration for ambiguous bare actions", () => {
    const message = undeclaredToolMessage("batch_update");

    assert.equal(message, "Tool 'batch_update' is not declared");
  });
});
