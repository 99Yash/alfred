import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { GoogleService } from "@alfred/integrations/google";
import { runGooglePassthrough } from "../../../src/modules/tools/passthrough";

const GOOGLE_NAMESPACES = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  slides: "https://slides.googleapis.com/v1",
} as const satisfies Record<GoogleService, string>;

describe("runGooglePassthrough", () => {
  test("couples every Google service gate to its pinned namespace and bearer token", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      for (const service of Object.keys(GOOGLE_NAMESPACES) as GoogleService[]) {
        const result = await runGooglePassthrough(service, `token-${service}`, {
          method: "GET",
          path: "/probe",
        });
        assert.equal(result.outcome, "http");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(
      requests,
      Object.entries(GOOGLE_NAMESPACES).map(([service, namespace]) => ({
        url: `${namespace}/probe`,
        authorization: `Bearer token-${service}`,
      })),
    );
  });
});
