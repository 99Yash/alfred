import assert from "node:assert/strict";
import { test } from "node:test";

import { createEvent } from "../src/google/calendar";

const CREATE_ARGS = {
  accessToken: "test-token",
  summary: "Planning",
  start: "2026-08-12T10:00:00+05:30",
  end: "2026-08-12T11:00:00+05:30",
} as const;

async function capturedCreateEventUrl(attendees?: string[]): Promise<URL> {
  const realFetch = globalThis.fetch;
  let requestedUrl: URL | null = null;
  globalThis.fetch = (async (input) => {
    requestedUrl = new URL(String(input));
    return new Response(JSON.stringify({ id: "evt_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await createEvent({ ...CREATE_ARGS, attendees });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(requestedUrl, "Calendar create_event must issue one request");
  return requestedUrl;
}

test("Calendar invitation delivery follows the shared attendee classifier", async () => {
  const inviteUrl = await capturedCreateEventUrl(["ada@example.com"]);
  const personalUrl = await capturedCreateEventUrl([]);

  assert.equal(inviteUrl.searchParams.get("sendUpdates"), "all");
  assert.equal(personalUrl.searchParams.has("sendUpdates"), false);
});
