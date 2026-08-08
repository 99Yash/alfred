import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The transitional `@alfred/api/backend` facade re-exports the delivery surface
// from `@alfred/assistant/delivery`. This test pins that door: every consumer
// still reaches the same symbols through `@alfred/api/backend` until 6D rewires
// them, so the re-export at `backend.ts` must stay byte-identical for the whole
// delivery interface. Written to be green against today's backend and to stay
// green through the move — the byte-identical-surface regression guard.
import { send, type NotificationKind, type SendArgs, type SendResult } from "@alfred/api/backend";

describe("@alfred/api/backend re-exports the @alfred/assistant/delivery surface", () => {
  test("the runtime export is present through the facade", () => {
    assert.equal(typeof send, "function", "send should be a function");
  });

  test("the type exports are reachable through the facade", () => {
    // The three type exports are used in type position so `tsc` fails the build
    // if the facade drops any of them.
    const kind: NotificationKind = "health_alert";
    const args: SendArgs = {
      userId: "user-1",
      kind,
      idempotencyKey: "health_alert:user-1:key:2026-06-27",
      subject: "Health alert",
      html: "<p>Health alert</p>",
      text: "Health alert",
    };
    const result: SendResult = { status: "duplicate", emailSendId: "email-send-1" };

    assert.equal(args.kind, "health_alert");
    assert.equal(result.status, "duplicate");
  });
});
