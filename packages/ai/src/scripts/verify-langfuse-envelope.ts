/**
 * Live check of trace attributes for three calls: chat (has a session), a background job
 * (no session), and an embedding (`call_kind:embedding`, no `cost_kind`).
 *
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/verify-langfuse-envelope.ts
 */
import { serverEnv } from "@alfred/env/server";
import { randomUUID } from "node:crypto";
import { flushLangfuse, langfuseTraceId, startLangfuseSpan } from "../metering/langfuse";
import type { MeteredMeta } from "../metering/metered";
import { fetchObservationsByTraceId } from "./langfuse-observations";

const stamp = randomUUID().slice(0, 8);

const chatRun = `run_chat_${stamp}`;

const jobRun = `run_job_${stamp}`;

const embedRun = `run_embed_${stamp}`;

const threadId = `thread_${stamp}`;

const cases: Array<{
  label: string;
  meta: MeteredMeta;
  expectSession: string | null;
  expectTags: string[];
}> = [
  {
    label: "chat (real session)",
    meta: {
      kind: "llm",
      role: "boss",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      runId: chatRun,
      sessionId: threadId,
      userId: "verify-user",
    },
    expectSession: threadId,
    expectTags: ["role:boss", "call_kind:llm"],
  },
  {
    label: "job (no session)",
    meta: {
      kind: "briefing",
      role: "briefing",
      provider: "google",
      model: "gemini-3.5-flash",
      runId: jobRun,
      userId: "verify-user",
    },
    expectSession: null,
    expectTags: ["role:briefing", "call_kind:llm", "cost_kind:briefing"],
  },
  {
    label: "embedding",
    meta: {
      kind: "embedding",
      provider: "voyage",
      model: "voyage-3",
      runId: embedRun,
      userId: "verify-user",
    },
    expectSession: null,
    expectTags: ["call_kind:embedding"],
  },
];

function openAndClose() {
  for (const c of cases) {
    const closer = startLangfuseSpan({ meta: c.meta, startedAt: new Date() });
    closer.success({
      usage: { inputTokens: 100, outputTokens: 20 },
      costUsd: 0.001,
      responseMeta: { finishReason: "stop" },
    });
  }
}

interface VerifiedTrace {
  sessionId?: string | null;
  tags?: string[] | null;
  environment?: string | null;
}

async function fetchTrace(
  host: string,
  auth: string,
  traceId: string,
): Promise<VerifiedTrace | null> {
  const observations = await fetchObservationsByTraceId({ host, auth, traceId });
  const first = observations[0];

  if (!first) return null;

  return {
    sessionId: first.sessionId ?? null,
    tags: first.tags ?? null,
    environment: first.environment ?? null,
  };
}

async function main() {
  const env = serverEnv();

  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    throw new Error("LANGFUSE keys missing — point --env-file at a configured .env");
  }

  const host = env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

  const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString(
    "base64",
  );

  console.log(`[verify] emitting spans (stamp=${stamp}) to ${host}`);
  openAndClose();
  await flushLangfuse();

  // Ingestion is async, so poll.
  const ids = [chatRun, jobRun, embedRun];
  let traces: Record<string, VerifiedTrace> = {};

  for (let attempt = 1; attempt <= 20; attempt++) {
    traces = {};

    for (const id of ids) {
      const t = await fetchTrace(host, auth, langfuseTraceId(id));

      if (t) traces[id] = t;
    }

    if (Object.keys(traces).length === ids.length) break;
    process.stdout.write(`  poll ${attempt}/20 (${Object.keys(traces).length}/3 visible)\r`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("");

  let failures = 0;

  for (const c of cases) {
    const id = c.label.startsWith("chat") ? chatRun : c.label.startsWith("job") ? jobRun : embedRun;
    const t = traces[id];

    if (!t) {
      console.log(`❌ ${c.label}: trace ${id} never appeared`);
      failures++;
      continue;
    }

    const gotSession = t.sessionId ?? null;
    const gotTags = [...(t.tags ?? [])].sort();
    const wantTags = [...c.expectTags].sort();
    const sessionOk = gotSession === c.expectSession;
    const tagsOk = JSON.stringify(gotTags) === JSON.stringify(wantTags);
    const env226 = t.environment;
    console.log(
      `${sessionOk && tagsOk ? "✅" : "❌"} ${c.label}\n` +
        `    sessionId: got=${JSON.stringify(gotSession)} want=${JSON.stringify(c.expectSession)} ${sessionOk ? "" : "<-- MISMATCH"}\n` +
        `    tags:      got=${JSON.stringify(gotTags)} ${tagsOk ? "" : `want=${JSON.stringify(wantTags)} <-- MISMATCH`}\n` +
        `    environment: ${JSON.stringify(env226)}`,
    );

    if (!sessionOk || !tagsOk) failures++;
  }

  console.log(failures === 0 ? "\n✅ ALL ENVELOPE ASSERTIONS PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
