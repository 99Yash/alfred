/**
 * Replay stored GitHub deliveries in `event_receipts` through the GitHub reducer,
 * so `integration_objects` includes history from before the live fold (#212, ADR-0062).
 * Without it, old merges never close their briefing loops.
 *
 * Replays in `delivered_at` order for the reducer's monotonic guard. The reducer is
 * idempotent. Bundled for prod. Dry by default; `--commit` writes (additive only).
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-object-state-github-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-object-state-github-committed.js --commit
 */
import {
  objectStateStore,
  parseReceiptEvent,
  receiptDeliveryInstant,
} from "@alfred/assistant/connections";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { db } from "@alfred/db";
import { typedEventReceipts, integrationObjects } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { eventTypeName, toMessage } from "@alfred/contracts";

const COMMIT = process.argv.includes("--commit");

async function main() {
  await warmPool();
  console.log(`# Object-state github backfill — mode=${COMMIT ? "COMMIT" : "DRY"}`);

  // The reducer folds only `pull_request`. Receipts carry their user (ADR-0097).
  const rows = await db()
    .select({
      userId: typedEventReceipts.userId,
      payload: typedEventReceipts.payload,
      // Microseconds, not a JS `Date`, so the order matches the live fold (#1200).
      deliveredAt: receiptDeliveryInstant(),
    })
    .from(typedEventReceipts)
    .where(
      and(
        eq(typedEventReceipts.provider, "github"),
        eq(typedEventReceipts.eventType, eventTypeName("github", "pull_request")),
      ),
    )
    .orderBy(asc(typedEventReceipts.deliveredAt));

  // A body that is not a JSON object cannot be folded or counted.
  const deliveries = rows.flatMap((row) => {
    const event = parseReceiptEvent("github", "pull_request", row.payload);

    if (event?.eventType !== "pull_request") return [];

    return [{ userId: row.userId, event, deliveredAt: row.deliveredAt }];
  });

  console.log(`  ${deliveries.length} pull_request deliveries to replay`);

  if (!COMMIT) {
    const byAction = new Map<string, number>();

    for (const r of deliveries) {
      const action = r.event.payload.action ?? "(none)";

      byAction.set(action, (byAction.get(action) ?? 0) + 1);
    }

    console.log("  DRY — action breakdown:");

    for (const [action, count] of byAction) console.log(`    ${action}: ${count}`);
    console.log("  (pass --commit to project these into integration_objects)");

    return;
  }

  let applied = 0;

  for (const r of deliveries) {
    await objectStateStore.applyEvent({
      userId: r.userId,
      event: r.event,
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

try {
  await main();
} catch (e) {
  // Message only: a serialized Error can leak DATABASE_URL.
  console.error(toMessage(e));
  process.exitCode = 1;
} finally {
  await closeScriptResources();
}
