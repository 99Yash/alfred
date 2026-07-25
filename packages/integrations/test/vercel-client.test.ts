import { HttpError, redacted } from "@alfred/contracts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createVercelClient } from "../src/vercel/client";
import { readVercelTeamId, vercelCredentialMetadata } from "../src/vercel/credential";

/**
 * The Vercel client is now the ONE door to `api.vercel.com` on a user's behalf.
 * These pin what is genuinely Vercel-specific — the seam's own mechanics (pinned
 * query beating a caller's, POST never retried, bounded error bodies) are pinned
 * once in `provider-client.test.ts` and not restated here.
 *
 * The team scope gets the most coverage because its failure mode is silent. A
 * team token sent WITHOUT `?teamId=` does not 401 — Vercel answers in
 * personal-account scope with a `200` and an empty list, which reaches the model
 * as a confident "you have no projects". That is exactly the bug the reader/writer
 * pair in `src/vercel/credential.ts` exists to prevent, so the round trip is
 * pinned rather than assumed.
 *
 * `createVercelClient` (not `vercelClientForUser`) is used deliberately: it takes
 * the resolver directly, so this runs offline with no DB and no memoization
 * hiding the resolve count.
 */

const realFetch = globalThis.fetch;

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(teamId: string | null, onResolve?: () => void) {
  return createVercelClient({
    resolveAuth: async () => {
      onResolve?.();
      return { token: redacted("vercel_secret_token"), teamId };
    },
  });
}

const PROJECTS = {
  projects: [
    {
      id: "prj_1",
      name: "alfred",
      framework: "nextjs",
      latestDeployments: [{ readyState: "READY" }],
    },
    { id: "prj_2", name: "site", framework: null },
  ],
};

const DEPLOYMENTS = {
  deployments: [
    { uid: "dpl_1", name: "alfred", url: "alfred.vercel.app", readyState: "READY", created: 1 },
  ],
};

describe("vercel credential metadata", () => {
  test("what connect writes is what the client reads back", () => {
    // The regression guard for the real bug: a reader spelled `teamId` while the
    // route persisted `team_id`, so this round trip silently returned null.
    const metadata = vercelCredentialMetadata({
      tokens: {
        accessToken: "vercel_secret_token",
        tokenType: "Bearer",
        installationId: "icfg_1",
        userId: "usr_1",
        teamId: "team_abc",
      },
      configurationId: "cfg_1",
    });
    assert.equal(readVercelTeamId(metadata), "team_abc");
  });

  test("a personal install round-trips to null, not to a bogus scope", () => {
    const metadata = vercelCredentialMetadata({
      tokens: {
        accessToken: "t",
        tokenType: "Bearer",
        installationId: null,
        userId: "usr_1",
        teamId: null,
      },
      configurationId: null,
    });
    assert.equal(readVercelTeamId(metadata), null);
  });

  test("reads jsonb defensively — a wrong shape or empty string is null, never a throw", () => {
    assert.equal(readVercelTeamId(undefined), null);
    assert.equal(readVercelTeamId("team_abc"), null);
    assert.equal(readVercelTeamId({ team_id: 42 }), null);
    assert.equal(readVercelTeamId({ team_id: "" }), null);
    // The spelling that caused the bug must NOT be honoured — one key, one home.
    assert.equal(readVercelTeamId({ teamId: "team_abc" }), null);
  });
});

describe("vercel client team scope", () => {
  test("a team install pins teamId on every curated read", async () => {
    const calls = stubFetch(PROJECTS);
    await client("team_abc").projects({ limit: 5 });
    const url = new URL(calls[0]?.url ?? "");
    assert.equal(url.searchParams.get("teamId"), "team_abc");
    assert.equal(url.searchParams.get("limit"), "5");
  });

  test("a personal install sends no teamId at all", async () => {
    const calls = stubFetch(DEPLOYMENTS);
    await client(null).deployments({ limit: 5 });
    const url = new URL(calls[0]?.url ?? "");
    assert.equal(url.searchParams.has("teamId"), false);
  });

  test("the passthrough profile carries the same pinned team scope the reads do", async () => {
    // Otherwise a raw `vercel.request` would read personal scope on a team
    // install and report an empty result as a confident zero.
    const profile = await client("team_abc").passthroughProfile();
    assert.deepEqual(profile.fixedQuery, { teamId: "team_abc" });
    const personal = await client(null).passthroughProfile();
    assert.equal(personal.fixedQuery, undefined);
  });
});

describe("vercel client auth", () => {
  test("unwraps the token only into the Authorization header", async () => {
    const calls = stubFetch(PROJECTS);
    await client("team_abc").projects();
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.headers.Authorization, "Bearer vercel_secret_token");
    // The secret must never ride the URL — that is what reaches logs and errors.
    assert.ok(!call.url.includes("vercel_secret_token"));
  });

  test("a non-2xx error carries the redacted label, never the token", async () => {
    stubFetch({ error: { code: "forbidden" } }, 403);
    await assert.rejects(client("team_abc").projects(), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.url, "/v10/projects");
      const text = JSON.stringify(err) + String(err);
      assert.ok(!text.includes("vercel_secret_token"), "the token must not reach the error");
      return true;
    });
  });

  test("passthroughProfile pins the authority and carries auth as data", async () => {
    const profile = await client("team_abc").passthroughProfile();
    assert.equal(profile.baseUrl, "https://api.vercel.com");
    assert.equal(profile.headers.Authorization, "Bearer vercel_secret_token");
  });

  test("createVercelClient resolves per request — memoization belongs to the bind", async () => {
    stubFetch(PROJECTS);
    let resolves = 0;
    const vercel = client("team_abc", () => {
      resolves += 1;
    });
    await vercel.projects();
    await vercel.passthroughProfile();
    assert.equal(resolves, 2, "the resolver-injection constructor must not cache");
  });
});

describe("vercel client redeploy", () => {
  test("accepts either uid or id as the deployment handle", async () => {
    const calls = stubFetch({ id: "dpl_new", url: "x.vercel.app", readyState: "QUEUED" });
    const result = await client("team_abc").redeploy({ deploymentId: "dpl_1", name: "alfred" });
    assert.deepEqual(result, { uid: "dpl_new", url: "x.vercel.app", state: "QUEUED" });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).searchParams.get("forceNew"), "1");
  });

  test("a 2xx with no handle is a failure, not a silent success", async () => {
    stubFetch({ url: "x.vercel.app" });
    await assert.rejects(client(null).redeploy({ deploymentId: "dpl_1", name: "alfred" }), {
      message: "[vercel] redeploy returned no deployment id",
    });
  });

  test("a failed redeploy is attempted exactly once — never re-sent", async () => {
    // A live deploy is the one call in this file that must not double-apply: the
    // POST may have landed before the failure. Pinned here, not just at the seam.
    const calls = stubFetch({ error: "boom" }, 500);
    await assert.rejects(
      client("team_abc").redeploy({ deploymentId: "dpl_1", name: "alfred" }),
      HttpError,
    );
    assert.equal(calls.length, 1);
  });
});
