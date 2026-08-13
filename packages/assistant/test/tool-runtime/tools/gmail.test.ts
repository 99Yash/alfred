import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { gmailSendDraftInput } from "@alfred/contracts";
import { z } from "zod";

describe("gmailSendDraftInput body alias (param-ergonomics)", () => {
  test("folds the plain-English `body` synonym into bodyText", () => {
    const parsed = gmailSendDraftInput.parse({
      to: ["a@example.com"],
      subject: "Hello",
      body: "This is the message body.",
    });
    assert.equal((parsed as { bodyText?: string }).bodyText, "This is the message body.");
    assert.ok(!("body" in (parsed as object)));
  });

  test("an explicit bodyText wins over a stray body", () => {
    const parsed = gmailSendDraftInput.parse({
      to: ["a@example.com"],
      subject: "Hello",
      bodyText: "canonical",
      body: "ignored",
    });
    assert.equal((parsed as { bodyText?: string }).bodyText, "canonical");
  });

  test("the model-facing schema still advertises bodyText, not body", () => {
    const json = z.toJSONSchema(gmailSendDraftInput, { io: "input" }) as {
      properties?: Record<string, unknown>;
    };
    const keys = Object.keys(json.properties ?? {});
    assert.ok(keys.includes("bodyText"));
    assert.ok(!keys.includes("body"));
  });
});
