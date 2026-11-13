import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { undeclaredToolMessage } from "../../../src/tool-runtime/internal/dispatch/pipeline";

describe("undeclaredToolMessage", () => {
  test("points bare integration actions at exact loading and the qualified tool name", () => {
    const message = undeclaredToolMessage("list_projects");

    assert.match(message, /vercel\.list_projects/);
    assert.match(message, /vercel exposes: `list_projects`, `list_deployments`/);
    assert.match(message, /system\.load_tool/);
    assert.match(message, /name 'vercel\.list_projects'/);
    assert.match(message, /Do not ask the user/);
  });

  test("enumerates valid actions for an invented qualified integration tool", () => {
    const message = undeclaredToolMessage("contacts.find_people", ["contacts"]);

    assert.match(message, /contacts exposes: `search`, `list`, `get`/);
    // A `find_*` guess wants to enumerate, so point at `search`, not `get`.
    assert.match(message, /Use 'contacts\.search' instead/);
    assert.match(message, /system\.load_tool/);
  });

  test("does not suggest integrations outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("list_projects", ["github"]);

    assert.equal(message, "Tool 'list_projects' is not declared");
  });

  test("does not enumerate qualified tools outside a workflow allowlist", () => {
    const message = undeclaredToolMessage("calendar.read_events", ["github"]);

    assert.equal(message, "Tool 'calendar.read_events' is not declared");
  });

  test("recovers a bare integration slug (the boss mistook the integration for a tool)", () => {
    // No `system.load_tool` here: search activates its top hit, and other tools activate on
    // first call.
    const message = undeclaredToolMessage("vercel");

    assert.match(message, /vercel exposes: `list_projects`, `list_deployments`/);
    assert.match(message, /system\.search_tools for 'vercel'/);
    assert.doesNotMatch(message, /system\.load_tool/);
    assert.match(message, /Do not ask the user/);
  });

  test("does not recover a bare integration slug outside a workflow allowlist", () => {
    assert.equal(undeclaredToolMessage("vercel", ["github"]), "Tool 'vercel' is not declared");
  });

  test("does not suggest an integration for a bare action that no integration has", () => {
    const message = undeclaredToolMessage("batch_update");

    assert.equal(message, "Tool 'batch_update' is not declared");
  });
});
