/**
 * COMMITTED object-state backfill (issue #212, ADR-0062, one-off 2026-06-21).
 *
 * Replays the stored GitHub deliveries in `event_receipts` through the GitHub
 * reducer so the `integration_objects` projection reflects history that
 * predates the real-time fold in
 * `packages/assistant/src/connections/object-state/github-activity-consumer.ts`. Without this,
 * only PRs whose webhooks arrive *after* deploy would ever close a briefing
 * loop — the months of already-stored deliveries (including the merges that
 * should retire today's stuck CI-failure loops) would be invisible.
 *
 * Replay order is `delivered_at ASC` so the reducer's monotonic state guard
 * sees events in causal order (opened → synchronize → closed). The reducer is
 * idempotent, so re-running is safe.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfills/backfill-object-state-github-committed.js` — the prod
 * image has no `tsx`/loose `@alfred/*` sources.
 *
 * Dry by default — counts + previews but writes nothing. Pass `--commit`
 * to project state into the new tables (additive only; never deletes).
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-object-state-github-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-object-state-github-committed.js --commit
 */
import { objectStateStore } from "@alfred/assistant/connections";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { db } from "@alfred/db";
import { typedEventReceipts, integrationObjects } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { eventTypeName, getStringPath, jsonObjectSchema, toMessage } from "@alfred/contracts";

const COMMIT = process.argv.includes("--commit");

async function main() {
  await warmPool();
  console.log(`# Object-state github backfill — mode=${COMMIT ? "COMMIT" : "DRY"}`);

  // Every receipt is attributed to a credential, and so to a user, at receive
  // time (ADR-0097). `pull_request` is the sole kind the v1 reducer folds;
  // pulling just those keeps the replay tight.
  const rows = await db()
    .select({
      userId: typedEventReceipts.userId,
      payload: typedEventReceipts.payload,
      deliveredAt: typedEventReceipts.deliveredAt,
    })
    .from(typedEventReceipts)
    .where(
      and(
        eq(typedEventReceipts.provider, "github"),
        eq(typedEventReceipts.eventType, eventTypeName("github", "pull_request")),
      ),
    )
    .orderBy(asc(typedEventReceipts.deliveredAt));

  // A receipt whose body is not a JSON object cannot be folded; the reducer
  // would read nothing off it, so it is left out of the count as well.
  const deliveries = rows.flatMap((row) => {
    const stored = jsonObjectSchema.safeParse(row.payload);

    if (!stored.success) return [];

    return [
      {
        userId: row.userId,
        payload: stored.data,
        action: getStringPath(stored.data, "action") ?? null,
        deliveredAt: row.deliveredAt,
      },
    ];
  });

  console.log(`  ${deliveries.length} pull_request deliveries to replay`);

  if (!COMMIT) {
    const byAction = new Map<string, number>();

    for (const r of deliveries)
      byAction.set(r.action ?? "(none)", (byAction.get(r.action ?? "(none)") ?? 0) + 1);
    console.log("  DRY — action breakdown:");

    for (const [action, count] of byAction) console.log(`    ${action}: ${count}`);
    console.log("  (pass --commit to project these into integration_objects)");

    return;
  }

  let applied = 0;

  for (const r of deliveries) {
    await objectStateStore.applyEvent({
      userId: r.userId,
      provider: "github",
      eventType: "pull_request",
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
