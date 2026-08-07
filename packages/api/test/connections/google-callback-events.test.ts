import assert from "node:assert/strict";
import { test } from "node:test";

import { publishGoogleCallbackCompleted } from "../../src/modules/connections/google-routes";

test("publishes the completed Google callback through the domain event interface", async () => {
  const events: unknown[] = [];

  await publishGoogleCallbackCompleted("user-1", "credential-1", async (event) => {
    events.push(event);
    return { acceptedConsumers: 2 };
  });

  assert.deepEqual(events, [
    {
      userId: "user-1",
      source: "google.oauth.callback",
      type: "completed",
      eventId: "google.callback:credential-1",
    },
  ]);
});

test("keeps event publication failures best-effort at the OAuth callback boundary", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    await publishGoogleCallbackCompleted("user-1", "credential-1", async () => {
      throw new Error("triggers unavailable");
    });
    assert.match(String(warnings[0]?.[0]), /failed to publish completed event for user-1/);
    assert.equal(warnings[0]?.[1], "triggers unavailable");
  } finally {
    console.warn = originalWarn;
  }
});
