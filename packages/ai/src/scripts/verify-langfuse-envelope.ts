/**
 * Manual verification for the Langfuse envelope (#216/#226 + review fixes).
 * Drives the real `startLangfuseSpan` code path with three call shapes and
 * reads them back through the Langfuse public API to assert the envelope:
 *
 *   1. chat   — caller supplies a real `sessionId` (threadId) → grouped session
 *   2. job    — background run, no sessionId → MUST be sessionless (no runId
 *               fallback), proving the P2 Sessions-view-pollution fix
 *   3. embed  — embedding kind → `call_kind:embedding` tag, no `cost_kind`
 *
 * Run from packages/ai:
 *   ./node_modules/.bin/tsx --env-file=../../apps/server/.env \
 *     src/scripts/verify-langfuse-envelope.ts
 */
import { serverEnv } from "@alfred/env/server";
import { randomUUID } from "node:crypto";
import { flushLangfuse, startLangfuseSpan } from "../metering/langfuse";
import type { MeteredMeta } from "../metering/types";

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
      model: "gemini-2.5-pro",
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

async function fetchTrace(host: string, auth: string, traceId: string): Promise<any | null> {
  const res = await fetch(`${host}/api/public/traces/${traceId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET trace ${traceId} → ${res.status} ${await res.text()}`);
  return res.json();
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

  // Ingestion is async (worker). Poll until all three traces materialize.
  const ids = [chatRun, jobRun, embedRun];
  let traces: Record<string, any> = {};
  for (let attempt = 1; attempt <= 20; attempt++) {
    traces = {};
    for (const id of ids) {
      const t = await fetchTrace(host, auth, id);
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
