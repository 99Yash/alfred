/**
 * One GitHub control (ADR-0093 amendment 2026-11-13): the MCP routes do not end or reconsent
 * the GitHub MCP row. The GitHub account card owns its lifecycle, and its disconnect ends the
 * GitHub MCP row too.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test, type TestContext } from "node:test";

import { dbBackedSkip } from "../support/db-backed";
import { applyServerEnvFixtures } from "../support/server-env";

// `serverEnv()` memoizes, so seed first.
applyServerEnvFixtures();

const SKIP = dbBackedSkip("database");

/** The route graph reads the env when it loads, so load it only when the suite runs. */
async function load() {
  const [
    { auth },
    { closeConnections, db },
    { mcpConnections, mcpOauthCredentials, user },
    { eq, inArray, sql },
    { Elysia },
    { errorHandler, mcpIntegrationRoutes },
    { ensureBuiltInConnection, readOwnedConnection },
    { ensureConnection },
    { upsertGithubCredential },
    { githubIntegrationRoutes },
  ] = await Promise.all([
    import("@alfred/auth"),
    import("@alfred/db"),
    import("@alfred/db/schemas"),
    import("drizzle-orm"),
    import("elysia"),
    import("@alfred/http"),
    import("@alfred/assistant/connections/mcp"),
    import("@alfred/assistant/connections/mcp/test-support"),
    import("@alfred/integrations/github"),
    import("../../src/connections/github-routes"),
  ]);

  return {
    auth,
    closeConnections,
    db,
    mcpConnections,
    mcpOauthCredentials,
    user,
    eq,
    inArray,
    sql,
    ensureBuiltInConnection,
    readOwnedConnection,
    ensureConnection,
    upsertGithubCredential,
    app: new Elysia({ normalize: "typebox" })
      .use(errorHandler)
      .use(mcpIntegrationRoutes)
      .use(githubIntegrationRoutes),
  };
}

let m: Awaited<ReturnType<typeof load>>;

const ID_PREFIX = "test-ghmcp-control-";

const createdUserIds: string[] = [];

async function seedOnboardedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await m
    .db()
    .insert(m.user)
    .values({
      id: userId,
      name: "Test User",
      email: `${userId}@example.test`,
      onboardedAt: new Date(),
    });

  return userId;
}

/** Sign `userId` in for this test. Each request gets its own cookie, so no cached session leaks. */
function signIn(t: TestContext, userId: string): void {
  const now = new Date();

  t.mock.method(m.auth().api, "getSession", async () => ({
    session: {
      id: `session-${userId}`,
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: now,
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      token: `token-${userId}`,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: userId,
      createdAt: now,
      updatedAt: now,
      email: `${userId}@example.test`,
      emailVerified: true,
      name: "Test User",
      image: null,
    },
  }));
}

function request(path: string, method: "GET" | "POST" | "DELETE"): Request {
  return new Request(`http://localhost/api/integrations${path}`, {
    method,
    headers: { cookie: `better-auth.session_token=${randomUUID()}` },
  });
}

/** A GitHub MCP row that holds a working grant. Returns the row and its credential. */
async function seedReadyGithubRow(
  userId: string,
): Promise<{ connectionId: string; credentialId: string }> {
  const github = await m.ensureBuiltInConnection(userId, "github");

  const [credential] = await m
    .db()
    .insert(m.mcpOauthCredentials)
    .values({
      userId,
      connectionId: github.id,
      issuer: "https://github.com/login/oauth",
      // Plain text as a bound parameter: no code path here opens the token.
      accessToken: m.sql`${"access"}`,
      refreshToken: m.sql`${"refresh"}`,
      tokenType: "bearer",
    })
    .returning({ id: m.mcpOauthCredentials.id });

  assert.ok(credential);
  await m
    .db()
    .update(m.mcpConnections)
    .set({ status: "ready", credentialId: credential.id })
    .where(m.eq(m.mcpConnections.id, github.id));

  return { connectionId: github.id, credentialId: credential.id };
}

describe("GitHub MCP row has one control (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    m = await load();
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await m.db().delete(m.user).where(m.inArray(m.user.id, createdUserIds));
    }

    await m.closeConnections();
  });

  test("the MCP disconnect route refuses the GitHub row and keeps it ready", async (t) => {
    const userId = await seedOnboardedUser();
    const { connectionId: githubId } = await seedReadyGithubRow(userId);
    signIn(t, userId);

    const response = await m.app.handle(request(`/mcp/connections/${githubId}/disconnect`, "POST"));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Disconnect GitHub on its account card",
      code: "BAD_REQUEST",
    });
    assert.equal((await m.readOwnedConnection(githubId, userId))?.status, "ready");
  });

  test("the MCP disconnect route still ends a row with no owning integration", async (t) => {
    const userId = await seedOnboardedUser();

    const other = await m.ensureConnection({
      userId,
      label: "Other MCP",
      instanceKey: "default",
      canonicalResource: `mcp://test/${randomUUID()}`,
      endpoint: new URL("https://mcp.example.test/mcp"),
    });

    signIn(t, userId);

    const response = await m.app.handle(request(`/mcp/connections/${other.id}/disconnect`, "POST"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "disconnected" });
    assert.equal((await m.readOwnedConnection(other.id, userId))?.status, "disconnected");
  });

  test("the MCP consent doors of the GitHub row go to the GitHub connect route", async (t) => {
    const userId = await seedOnboardedUser();
    const { connectionId: githubId } = await seedReadyGithubRow(userId);
    signIn(t, userId);

    for (const door of ["authorize", "reconsent"]) {
      const response = await m.app.handle(request(`/mcp/connections/${githubId}/${door}`, "GET"));

      assert.equal(response.status, 302, door);
      assert.equal(
        new URL(response.headers.get("location") ?? "").pathname,
        "/api/integrations/github/connect",
        door,
      );
    }

    // A door that disconnects first would leave `disconnected` here.
    assert.equal((await m.readOwnedConnection(githubId, userId))?.status, "ready");
  });

  test("the GitHub account disconnect also disconnects the GitHub MCP and clears its grant", async (t) => {
    const userId = await seedOnboardedUser();
    const { connectionId, credentialId } = await seedReadyGithubRow(userId);

    const account = await m.upsertGithubCredential({
      userId,
      accountId: "4242",
      accountLabel: "octo",
      accessToken: "ghu_identity",
      installationId: "777",
      scopes: [],
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    signIn(t, userId);

    const response = await m.app.handle(request(`/github/${account.id}`, "DELETE"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: account.id, ok: true });

    const row = await m.readOwnedConnection(connectionId, userId);
    assert.equal(row?.status, "disconnected");
    assert.equal(row.currentCatalogRevisionId, null);

    const [tokens] = await m
      .db()
      .select({
        accessToken: m.mcpOauthCredentials.accessToken,
        refreshToken: m.mcpOauthCredentials.refreshToken,
      })
      .from(m.mcpOauthCredentials)
      .where(m.eq(m.mcpOauthCredentials.id, credentialId));

    assert.deepEqual(tokens, { accessToken: null, refreshToken: null });
  });
});
