import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import {
  ARTIFACT_SECTION_MAX_CHARS,
  DOCUMENT_MARKDOWN_MAX,
  appendArtifactSectionInput,
  createArtifactInput,
} from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, artifacts, chatThreads, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq, inArray } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import { appendArtifactSection, createArtifact } from "../../src/modules/artifacts/write";

/* ── schema caps (ADR-0085) — pure, always run ─────────────────────────── */

test("create_artifact caps its opening section at the per-call section budget", () => {
  assert.equal(
    createArtifactInput.safeParse({
      title: "Report",
      kind: "document",
      markdown: "x".repeat(ARTIFACT_SECTION_MAX_CHARS),
    }).success,
    true,
  );
  assert.equal(
    createArtifactInput.safeParse({
      title: "Report",
      kind: "document",
      markdown: "x".repeat(ARTIFACT_SECTION_MAX_CHARS + 1),
    }).success,
    false,
  );
});

test("append_artifact_section requires a non-empty artifactId and markdown", () => {
  assert.equal(
    appendArtifactSectionInput.safeParse({ artifactId: "art_1", markdown: "A section." }).success,
    true,
  );
  assert.equal(
    appendArtifactSectionInput.safeParse({ artifactId: "", markdown: "A section." }).success,
    false,
  );
  assert.equal(
    appendArtifactSectionInput.safeParse({ artifactId: "art_1", markdown: "" }).success,
    false,
  );
});

test("append_artifact_section caps each section at the per-call section budget", () => {
  assert.equal(
    appendArtifactSectionInput.safeParse({
      artifactId: "art_1",
      markdown: "x".repeat(ARTIFACT_SECTION_MAX_CHARS),
    }).success,
    true,
  );
  assert.equal(
    appendArtifactSectionInput.safeParse({
      artifactId: "art_1",
      markdown: "x".repeat(ARTIFACT_SECTION_MAX_CHARS + 1),
    }).success,
    false,
  );
});

test("append_artifact_section rejects unknown keys (strict boundary)", () => {
  assert.equal(
    appendArtifactSectionInput.safeParse({
      artifactId: "art_1",
      markdown: "A section.",
      title: "not a param",
    }).success,
    false,
  );
});

/* ── write path (ADR-0085) — DB-backed, opt-in ─────────────────────────── */

const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const ID_PREFIX = "test-artifact-section-";
const createdUserIds: string[] = [];

async function seedTurn(): Promise<{ userId: string; threadId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const threadId = randomUUID();
  await db().insert(chatThreads).values({ id: threadId, userId });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "__test-artifact-section",
    currentStep: "chat",
    status: "runnable",
    attempt: 0,
    state: {},
    lastCheckpointAt: new Date(),
  });
  return { userId, threadId, runId };
}

async function readMarkdown(artifactId: string): Promise<string> {
  const [row] = await db()
    .select({ content: artifacts.content })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  assert.ok(row?.content && row.content.kind === "document", "document content present");
  return row.content.markdown;
}

describe("appendArtifactSection write path", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
    await closeRedis();
  });

  test("concatenates each section onto the body with a blank-line separator", async () => {
    const ctx = await seedTurn();
    const created = await createArtifact(ctx, {
      title: "Report",
      kind: "document",
      markdown: "## Opening\n\nFirst section.",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const r1 = await appendArtifactSection(ctx, {
      artifactId: created.artifactId,
      markdown: "## Middle\n\nSecond section.",
    });
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.contentChars, (await readMarkdown(created.artifactId)).length);

    await appendArtifactSection(ctx, {
      artifactId: created.artifactId,
      markdown: "## Close\n\nThird section.",
    });

    assert.equal(
      await readMarkdown(created.artifactId),
      "## Opening\n\nFirst section.\n\n## Middle\n\nSecond section.\n\n## Close\n\nThird section.",
    );
  });

  test("appends without a leading separator when the document started empty", async () => {
    const ctx = await seedTurn();
    const created = await createArtifact(ctx, { title: "Empty start", kind: "document" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await appendArtifactSection(ctx, {
      artifactId: created.artifactId,
      markdown: "## Only section",
    });
    assert.equal(await readMarkdown(created.artifactId), "## Only section");
  });

  test("refuses a pages artifact with wrong_kind", async () => {
    const ctx = await seedTurn();
    const created = await createArtifact(ctx, { title: "Deck", kind: "pages", format: "slides" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await appendArtifactSection(ctx, {
      artifactId: created.artifactId,
      markdown: "## Nope",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, "wrong_kind");
  });

  test("returns not_found for an unknown artifactId", async () => {
    const ctx = await seedTurn();
    const result = await appendArtifactSection(ctx, {
      artifactId: `art_${randomUUID()}`,
      markdown: "## Nope",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, "not_found");
  });

  test("refuses accumulation past the stored document cap with content_limit", async () => {
    const ctx = await seedTurn();
    const created = await createArtifact(ctx, {
      title: "Near the cap",
      kind: "document",
      // Seed within 5 chars of the stored ceiling (createArtifact does not cap
      // markdown — the per-call cap is a schema-boundary concern), so a small
      // append plus the "\n\n" separator overflows DOCUMENT_MARKDOWN_MAX.
      markdown: "x".repeat(DOCUMENT_MARKDOWN_MAX - 5),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await appendArtifactSection(ctx, {
      artifactId: created.artifactId,
      markdown: "y".repeat(10),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, "content_limit");
    // The body is left untouched when the append would overflow.
    assert.equal((await readMarkdown(created.artifactId)).length, DOCUMENT_MARKDOWN_MAX - 5);
  });

  test("row lock preserves every section under concurrent appends", async () => {
    const ctx = await seedTurn();
    const created = await createArtifact(ctx, {
      title: "Concurrent",
      kind: "document",
      markdown: "A",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const [b, c] = await Promise.all([
      appendArtifactSection(ctx, { artifactId: created.artifactId, markdown: "B" }),
      appendArtifactSection(ctx, { artifactId: created.artifactId, markdown: "C" }),
    ]);
    assert.equal(b.ok, true);
    assert.equal(c.ok, true);

    const parts = (await readMarkdown(created.artifactId)).split("\n\n");
    assert.equal(parts[0], "A");
    assert.deepEqual([...parts].sort(), ["A", "B", "C"]);
  });
});
