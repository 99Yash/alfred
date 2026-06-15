import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveTodoInput, type TodoSource } from "@alfred/contracts";

import {
  gmailThreadIdsFromSources,
  gmailThreadIdsFromTodoSources,
} from "../../src/modules/todos/resolve";

describe("gmailThreadIdsFromSources", () => {
  test("extracts unique Gmail thread source ids", () => {
    const sources: TodoSource[] = [
      { provider: "gmail", kind: "thread", id: "thread_a" },
      { provider: "gmail", kind: "thread", id: "thread_a", url: "https://mail.google.com/x" },
      { provider: "gmail", kind: "message", id: "msg_a" },
      { provider: "slack", kind: "thread", id: "thread_b" },
    ];

    assert.deepEqual(gmailThreadIdsFromSources(sources), ["thread_a"]);
  });

  test("returns empty for malformed stored sources", () => {
    assert.deepEqual(gmailThreadIdsFromTodoSources({ provider: "gmail" }), []);
  });
});

describe("resolveTodoInput", () => {
  test("stays lenient so unresolved sender/source reaches the handler", () => {
    assert.equal(
      resolveTodoInput.safeParse({
        kind: "gmail_sender",
        reason: "standing_instruction_sender_suppression",
      }).success,
      true,
    );
  });

  test("normalizes sender emails before dispatch", () => {
    const parsed = resolveTodoInput.parse({
      kind: "gmail_sender",
      senderEmail: " BEN@Example.com ",
    });

    assert.equal(parsed.senderEmail, "ben@example.com");
  });
});
