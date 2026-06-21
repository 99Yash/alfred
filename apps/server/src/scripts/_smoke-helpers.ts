import { db } from "@alfred/db";
import { agentRuns, user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

export const POLL_INTERVAL_MS = 250;
export const POLL_TIMEOUT_MS = 30_000;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function isTerminal(s: string): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export async function findOrCreateSmokeUser(
  email: string,
  name: string = "Smoke Tester",
): Promise<string> {
  const existing = await db()
    .select()
    .from(userTable)
    .where(eq(userTable.email, email));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name, email, emailVerified: true })
    .returning({ id: userTable.id });
  if (!inserted[0]) throw new Error("failed to insert smoke user");
  return inserted[0].id;
}

export async function pollUntil(
  runId: string,
  predicate: (status: string) => boolean,
  label: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<{ status: string; output: unknown; wakeCondition: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db()
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    const row = rows[0];
    if (!row)
      throw new Error(`run ${runId} not found while waiting for ${label}`);
    if (predicate(row.status)) {
      return {
        status: row.status,
        output: row.output,
        wakeCondition: row.wakeCondition,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

export async function pollRun(
  runId: string,
  label: string,
  timeoutMs = POLL_TIMEOUT_MS,
  logPrefix = "[smoke]",
) {
  const deadline = Date.now() + timeoutMs;
  let lastStep: string | null = null;
  while (Date.now() < deadline) {
    const [row] = await db()
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    if (!row)
      throw new Error(`run ${runId} not found while waiting for ${label}`);
    if (row.currentStep !== lastStep) {
      if (row.currentStep) {
        console.log(
          `${logPrefix}   step → ${row.currentStep} (status=${row.status})`,
        );
      }
      lastStep = row.currentStep;
    }
    if (isTerminal(row.status)) {
      return row;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

export async function createSmokeRun(
  userId: string,
  label: string,
  workflowSlug: string = "smoke-dispatch",
): Promise<string> {
  const inserted = await db()
    .insert(agentRuns)
    .values({
      userId,
      workflowSlug,
      currentStep: label,
      status: "running",
      trigger: { kind: "manual" },
    })
    .returning({ id: agentRuns.id });
  if (!inserted[0]) throw new Error("failed to insert smoke run");
  return inserted[0].id;
}
