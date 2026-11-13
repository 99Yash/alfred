import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyServerEnvFixtures } from "../support/server-env";

// `serverEnv()` memoizes, so seed first. No service is dialed: every GitHub and DB read is a
// stub, and the URLs only make the env parse.
applyServerEnvFixtures({
  databaseUrl: "postgresql://localhost:5432/alfred_test",
  redisUrl: "redis://localhost:6379",
});

const { callbackTarget, connectUrl, installationForGrant } =
  await import("../../src/connections/github-routes");

type Reads = NonNullable<Parameters<typeof installationForGrant>[1]> &
  NonNullable<Parameters<typeof connectUrl>[2]>;

type StoredCredential = Awaited<ReturnType<Reads["listGithubCredentials"]>>[number];

function storedCredential(accountId: string, installationId: string | null): StoredCredential {
  return {
    id: `cred_${accountId}`,
    status: "active",
    accountId,
    accountLabel: `login-${accountId}`,
    installationId,
  };
}

/** Stub reads that record each GitHub call, so a test can prove which reads ran. */
function reads(input: {
  readonly stored: StoredCredential[];
  readonly accessible?: boolean;
  readonly found?: string | null;
  readonly personal?: boolean | Error;
}) {
  const calls: string[] = [];

  const stub: Reads = {
    listGithubCredentials: async () => {
      calls.push("list");

      return input.stored;
    },
    canUserAccessInstallation: async (args) => {
      calls.push(`access:${args.installationId}:${args.accessToken}`);

      return input.accessible ?? false;
    },
    findUserInstallation: async (args) => {
      calls.push(`find:${args.accountId}`);

      return input.found ?? null;
    },
    hasPersonalInstallation: async () => {
      calls.push("personal");

      if (input.personal instanceof Error) throw input.personal;

      return input.personal ?? false;
    },
  };

  return { calls, stub };
}

const GRANT = { userId: "user_1", accessToken: "ghu_new", accountId: "100" } as const;

describe("installationForGrant (callback with a code and no installation_id)", () => {
  test("keeps the stored installation while the user can still reach it", async () => {
    const { calls, stub } = reads({
      stored: [storedCredential("100", "org-install-7")],
      accessible: true,
      found: "personal-install-9",
    });

    assert.equal(await installationForGrant(GRANT, stub), "org-install-7");
    assert.deepEqual(calls, ["list", "access:org-install-7:ghu_new"]);
  });

  test("falls back to the user's own installation when the stored one is out of reach", async () => {
    const { calls, stub } = reads({
      stored: [storedCredential("100", "org-install-7")],
      accessible: false,
      found: "personal-install-9",
    });

    assert.equal(await installationForGrant(GRANT, stub), "personal-install-9");
    assert.deepEqual(calls, ["list", "access:org-install-7:ghu_new", "find:100"]);
  });

  test("reads only the stored installation of the same GitHub account", async () => {
    const { calls, stub } = reads({
      stored: [storedCredential("200", "other-account-install")],
      accessible: true,
      found: null,
    });

    // `null` sends the callback to the install screen.
    assert.equal(await installationForGrant(GRANT, stub), null);
    assert.deepEqual(calls, ["list", "find:100"]);
  });
});

describe("connectUrl", () => {
  test("a stored installation goes to the user authorization with no GitHub read", async () => {
    const { calls, stub } = reads({
      stored: [storedCredential("100", "org-install-7")],
      personal: false,
    });

    const url = new URL(await connectUrl("user_1", "state-1", stub));

    assert.equal(`${url.origin}${url.pathname}`, "https://github.com/login/oauth/authorize");
    assert.equal(url.searchParams.get("state"), "state-1");
    assert.deepEqual(calls, ["list"]);
  });

  test("with no stored installation, the App installation on GitHub picks the screen", async () => {
    const installed = reads({ stored: [storedCredential("100", null)], personal: true });
    const authorize = new URL(await connectUrl("user_1", "state-2", installed.stub));

    assert.equal(authorize.pathname, "/login/oauth/authorize");
    assert.deepEqual(installed.calls, ["list", "personal"]);

    const missing = reads({ stored: [], personal: false });
    const install = new URL(await connectUrl("user_1", "state-3", missing.stub));

    assert.match(install.pathname, /^\/apps\/[^/]+\/installations\/new$/);
    assert.equal(install.searchParams.get("state"), "state-3");
  });

  test("a failed GitHub read uses the user authorization", async () => {
    const { stub } = reads({ stored: [], personal: new Error("GitHub is down") });
    const url = new URL(await connectUrl("user_1", "state-4", stub));

    assert.equal(url.pathname, "/login/oauth/authorize");
  });
});

describe("callbackTarget", () => {
  test("names a failed or consent-blocked GitHub MCP adoption on the redirect", () => {
    for (const grantOutcome of [
      { outcome: "failed", message: "token endpoint refused" },
      { outcome: "auth_required" },
    ] as const) {
      const integrations = new URL(
        callbackTarget({ stillOnboarding: false, accountLogin: "octo cat", grantOutcome }),
      );

      assert.equal(integrations.pathname, "/integrations");
      assert.equal(integrations.searchParams.get("github_connected"), "octo cat");
      assert.equal(integrations.searchParams.get("github_mcp_error"), grantOutcome.outcome);

      const onboarding = new URL(
        callbackTarget({ stillOnboarding: true, accountLogin: "octo", grantOutcome }),
      );

      assert.equal(onboarding.pathname, "/onboarding");
      assert.equal(onboarding.searchParams.get("step"), "2");
      assert.equal(onboarding.searchParams.get("github_mcp_error"), grantOutcome.outcome);
    }
  });

  test("a connected adoption adds no error parameter", () => {
    const url = new URL(
      callbackTarget({
        stillOnboarding: false,
        accountLogin: "octo",
        grantOutcome: { outcome: "connected" },
      }),
    );

    assert.equal(url.pathname, "/integrations");
    assert.equal(url.searchParams.get("github_connected"), "octo");
    assert.equal(url.searchParams.has("github_mcp_error"), false);
  });

  test("a callback with no code goes to the GitHub connect route", () => {
    const url = new URL(
      callbackTarget({ stillOnboarding: false, accountLogin: "octo", grantOutcome: null }),
    );

    assert.equal(url.pathname, "/api/integrations/github/connect");
    assert.equal(url.searchParams.has("github_mcp_error"), false);
  });
});
