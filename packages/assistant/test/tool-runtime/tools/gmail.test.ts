import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { gmailSendDraftInput } from "@alfred/contracts";
import { z } from "zod";
import { assertGmailRecipientsAllowed } from "../../../src/tool-runtime/internal/tools/gmail-recipient-policy";

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

describe("gmail.send_draft recipient policy", () => {
  const input = {
    to: ["Alice@Example.com"],
    cc: ["cc@example.com"],
    bcc: ["me@example.com"],
  };

  test("allows the active mailbox and every person the user emailed before", async () => {
    await assertGmailRecipientsAllowed(
      { userId: "user-1", activeMailbox: "Me <ME@example.com>", input },
      async (userId) => {
        assert.equal(userId, "user-1");
        return [
          {
            aliases: ["alice@example.com", "Alice Example"],
            metadata: { correspondence: { inbound: 5, outbound: 1 } },
          },
          {
            aliases: ["cc@example.com"],
            metadata: { correspondence: { outbound: 3 } },
          },
        ];
      },
    );
  });

  test("does not let an inbound-only sender add itself to the allow-list", async () => {
    await assert.rejects(
      assertGmailRecipientsAllowed(
        {
          userId: "user-1",
          activeMailbox: "me@example.com",
          input: { to: ["attacker@example.com"] },
        },
        async () => [
          {
            aliases: ["attacker@example.com"],
            metadata: { correspondence: { inbound: 1, outbound: 0 } },
          },
        ],
      ),
      /live send blocked for new recipient\(s\): attacker@example\.com/,
    );
  });

  test("ignores malformed persisted correspondence metadata", async () => {
    await assert.rejects(
      assertGmailRecipientsAllowed(
        {
          userId: "user-1",
          activeMailbox: "me@example.com",
          input: { to: ["malformed@example.com"] },
        },
        async () => [
          {
            aliases: ["malformed@example.com"],
            metadata: { correspondence: { outbound: "many" } },
          },
        ],
      ),
      /live send blocked for new recipient\(s\): malformed@example\.com/,
    );
  });

  test("checks cc and bcc as well as to, and reports every new recipient once", async () => {
    await assert.rejects(
      assertGmailRecipientsAllowed(
        {
          userId: "user-1",
          activeMailbox: "me@example.com",
          input: {
            to: ["known@example.com"],
            cc: ["new-cc@example.com"],
            bcc: ["NEW-BCC@example.com", "new-bcc@example.com"],
          },
        },
        async () => [
          {
            aliases: ["known@example.com"],
            metadata: { correspondence: { outbound: 1 } },
          },
        ],
      ),
      /new-cc@example\.com, new-bcc@example\.com/,
    );
  });

  test("fails closed when contact evidence cannot be read", async () => {
    await assert.rejects(
      assertGmailRecipientsAllowed(
        {
          userId: "user-1",
          activeMailbox: "me@example.com",
          input: { to: ["known@example.com"] },
        },
        async () => {
          throw new Error("database unavailable");
        },
      ),
      /database unavailable/,
    );
  });
});
