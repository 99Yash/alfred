/**
 * COMMITTED object-state backfill (issue #212, ADR-0062, one-off 2026-06-21).
 *
 * Replays the existing `webhook_events` log through the GitHub reducer so the
 * `integration_objects` projection reflects history that predates the
 * real-time hook in `github-webhook.ts`. Without this, only PRs whose webhooks
 * arrive *after* deploy would ever close a briefing loop — the months of
 * already-stored deliveries (including the merges that should retire today's
 * stuck CI-failure loops) would be invisible.
 *
 * Replay order is `delivered_at ASC` so the reducer's monotonic state guard
 * sees events in causal order (opened → synchronize → closed). The reducer is
 * idempotent, so re-running is safe.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfills/backfill-object-state-github-committed.js` — the prod
 * image has no `tsx`/loose `@alfred/*` sources.
 *
 * SAFETY: dry by default — counts + previews but writes nothing. Pass `--commit`
 * to project state into the new tables (additive only; never deletes).
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-object-state-github-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-object-state-github-committed.js --commit
 */
import { objectStateStore } from "@alfred/api/backend";
import { warmPool } from "@alfred/api/runtime";
import { closeScriptResources } from "../script-runtime";
import { db } from "@alfred/db";
import { integrationObjects, webhookEvents } from "@alfred/db/schemas";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { toMessage } from "@alfred/contracts";

const COMMIT = process.argv.includes("--commit");

async function main() {
  await warmPool();
  console.log(`# Object-state github backfill — mode=${COMMIT ? "COMMIT" : "DRY"}`);

  // Only deliveries attributable to a user can project (the projection is
  // per-user). `pull_request` is the sole kind the v1 reducer folds; pulling
  // just those keeps the replay tight.
  const rows = await db()
    .select({
      userId: webhookEvents.userId,
      eventType: webhookEvents.eventType,
      action: webhookEvents.action,
      payload: webhookEvents.payload,
      deliveredAt: webhookEvents.deliveredAt,
    })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, "github"),
        eq(webhookEvents.eventType, "pull_request"),
        isNotNull(webhookEvents.userId),
      ),
    )
    .orderBy(asc(webhookEvents.deliveredAt));

  console.log(`  ${rows.length} pull_request deliveries to replay`);

  if (!COMMIT) {
    const byAction = new Map<string, number>();
    for (const r of rows)
      byAction.set(r.action ?? "(none)", (byAction.get(r.action ?? "(none)") ?? 0) + 1);
    console.log("  DRY — action breakdown:");
    for (const [action, count] of byAction) console.log(`    ${action}: ${count}`);
    console.log("  (pass --commit to project these into integration_objects)");
    return;
  }

  let applied = 0;
  for (const r of rows) {
    if (!r.userId) continue;
    await objectStateStore.applyEvent({
      userId: r.userId,
      provider: "github",
      eventType: r.eventType,
      action: r.action,
      payload: r.payload,
      deliveredAt: r.deliveredAt,
    });
    applied += 1;
  }

  const objects = await db()
    .select({ stateCategory: integrationObjects.stateCategory })
    .from(integrationObjects)
    .where(eq(integrationObjects.provider, "github"));
  const byState = new Map<string, number>();
  for (const o of objects) byState.set(o.stateCategory, (byState.get(o.stateCategory) ?? 0) + 1);

  console.log(`  PERSISTED — replayed ${applied} deliveries → ${objects.length} objects projected`);
  for (const [state, count] of byState) console.log(`    ${state}: ${count}`);
}

main()
  .catch((e) => {
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });
