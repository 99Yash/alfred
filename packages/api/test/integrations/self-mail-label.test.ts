import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpError } from "@alfred/contracts";
import type { LabelSelfMailDeps } from "@alfred/integrations/google";

// serverEnv() validates the whole schema on first read; seed the required slots
// before importing `@alfred/integrations/google` (its module graph reads env
// lazily, but be defensive). Mirrors `self-authored-drop.test.ts`.
const SERVER_ENV_FIXTURES: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <hey@alfred.beauty>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
  ENTITY_ID_NAMESPACE: "stable namespace secret for tests",
};
for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
  process.env[key] ??= value;
}

const { labelSelfAuthoredMail } = await import("@alfred/integrations/google");

const LABEL_ID = "Label_alfred_1";

/** Recording fake deps so the DI seam exercises skip / retry without a mailbox. */
function makeDeps(
  overrides: {
    /** Label id returned per ensureLabel call (index-aligned to call count). */
    ensureIds?: string[];
    /** If set, addLabel throws for the first N calls then succeeds. */
    failAddCalls?: number;
    failStatus?: number;
  } = {},
): {
  deps: LabelSelfMailDeps;
  ensureCalls: Array<{ force?: boolean }>;
  addCalls: Array<{ messageId: string; labelId: string }>;
} {
  const ensureCalls: Array<{ force?: boolean }> = [];
  const addCalls: Array<{ messageId: string; labelId: string }> = [];
  const ensureIds = overrides.ensureIds ?? [LABEL_ID, LABEL_ID];
  let addAttempts = 0;
  const deps: LabelSelfMailDeps = {
    ensureLabel: async ({ force }) => {
      const id = ensureIds[ensureCalls.length] ?? ensureIds[ensureIds.length - 1] ?? LABEL_ID;
      ensureCalls.push({ force });
      return id;
    },
    addLabel: async ({ messageId, labelId }) => {
      addAttempts++;
      if (overrides.failAddCalls && addAttempts <= overrides.failAddCalls) {
        throw new HttpError({
          provider: "gmail",
          method: "POST",
          status: overrides.failStatus ?? 404,
          url: `https://gmail.example/messages/${messageId}/modify`,
          body: `attempt ${addAttempts}`,
        });
      }
      addCalls.push({ messageId, labelId });
    },
  };
  return { deps, ensureCalls, addCalls };
}

describe("labelSelfAuthoredMail (#285)", () => {
  test("applies the self-label when the message lacks it", async () => {
    const { deps, addCalls } = makeDeps();
    const res = await labelSelfAuthoredMail(
      {
        credentialId: "cred_1",
        messageId: "msg_1",
        accessToken: "tok",
        currentLabelIds: ["INBOX"],
      },
      deps,
    );
    assert.deepEqual(res, { labeled: true, labelId: LABEL_ID });
    assert.deepEqual(addCalls, [{ messageId: "msg_1", labelId: LABEL_ID }]);
  });

  test("skips the modify round-trip when the label is already present", async () => {
    const { deps, addCalls } = makeDeps();
    const res = await labelSelfAuthoredMail(
      {
        credentialId: "cred_1",
        messageId: "msg_1",
        accessToken: "tok",
        currentLabelIds: ["INBOX", LABEL_ID],
      },
      deps,
    );
    assert.deepEqual(res, { labeled: false, labelId: LABEL_ID });
    assert.equal(addCalls.length, 0, "no write when the label is already on the message");
  });

  test("applies when currentLabelIds is absent (defensive: treat as unlabelled)", async () => {
    const { deps, addCalls } = makeDeps();
    const res = await labelSelfAuthoredMail(
      { credentialId: "cred_1", messageId: "msg_1", accessToken: "tok" },
      deps,
    );
    assert.equal(res.labeled, true);
    assert.equal(addCalls.length, 1);
  });

  test("rebuilds a stale label with force and retries once on a modify failure", async () => {
    // First ensure returns a stale id; addLabel 404s; force-rebuild returns a
    // fresh id; retry succeeds.
    const { deps, ensureCalls, addCalls } = makeDeps({
      ensureIds: ["Label_stale", "Label_fresh"],
      failAddCalls: 1,
    });
    const res = await labelSelfAuthoredMail(
      {
        credentialId: "cred_1",
        messageId: "msg_1",
        accessToken: "tok",
        currentLabelIds: ["INBOX"],
      },
      deps,
    );
    assert.deepEqual(res, { labeled: true, labelId: "Label_fresh" });
    assert.equal(ensureCalls.length, 2);
    assert.equal(ensureCalls[0]?.force, undefined, "first ensure is cache-first");
    assert.equal(ensureCalls[1]?.force, true, "retry rebuilds with force");
    // Only the successful (second) add is recorded; it targets the fresh id.
    assert.deepEqual(addCalls, [{ messageId: "msg_1", labelId: "Label_fresh" }]);
  });

  test("bubbles the error when the retry also fails", async () => {
    const { deps } = makeDeps({ failAddCalls: 2 });
    await assert.rejects(
      labelSelfAuthoredMail(
        {
          credentialId: "cred_1",
          messageId: "msg_1",
          accessToken: "tok",
          currentLabelIds: ["INBOX"],
        },
        deps,
      ),
      /404/,
    );
  });

  test("does not rebuild the label for non-stale modify failures", async () => {
    const { deps, ensureCalls, addCalls } = makeDeps({ failAddCalls: 1, failStatus: 403 });
    await assert.rejects(
      labelSelfAuthoredMail(
        {
          credentialId: "cred_1",
          messageId: "msg_1",
          accessToken: "tok",
          currentLabelIds: ["INBOX"],
        },
        deps,
      ),
      /403/,
    );
    assert.equal(ensureCalls.length, 1, "403 should not force-rebuild a label");
    assert.equal(addCalls.length, 0);
  });
});
