/**
 * Move each receipt body that is only on `event_receipts.payload` into its corpus document
 * (`documents.raw`), so the body has one copy (stores.md §8 step 3). The receive path no longer
 * stores the body on the receipt. Old receipts can still hold a body with no document: rows from
 * before the corpus projection, and receipts whose credential a disconnect deleted (the runtime
 * sweep skipped those until this change).
 *
 * The `payload` column, its reaper, its index, and the write-once trigger clause (migration 0139)
 * are dropped only after this reports 0 for each source. Dry by default: it prints the count.
 * `--commit` writes the documents (additive only), then prints the count again. Run it before
 * `backfill-object-state-github-committed.ts`.
 *
 * Embed cap: each document written counts against today's per-source embed cap
 * (`INBOUND_DAILY_EMBED_CAP`), because its admission time is now. Past the cap, a document is
 * stored but not embedded, and that includes live deliveries later the same day. The runtime sweep
 * has projected every receipt with a credential since #989, so the count is expected to be small.
 * If the dry count is near the cap, commit at a quiet time.
 *
 *   # report (writes nothing):
 *   node dist/scripts/backfills/backfill-receipt-documents-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-receipt-documents-committed.js --commit
 */
import {
  backfillReceiptDocuments,
  countReceiptBodiesWithoutDocument,
} from "@alfred/assistant/connections/ingestion/internal";
import { INBOUND_EVENT_SOURCES, toMessage, type InboundEventSource } from "@alfred/contracts";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

async function report(label: string): Promise<number> {
  let total = 0;

  for (const source of INBOUND_EVENT_SOURCES) {
    const left = await countReceiptBodiesWithoutDocument(source);
    total += left;
    console.log(`  ${label} ${source}: ${left} receipt bodies without a document`);
  }

  return total;
}

/**
 * Batches until a batch writes nothing. A failed row stays first in the order, so a full batch of
 * failed rows also stops the loop. The second count then shows what is left, and the exit code is 1.
 */
async function drain(source: InboundEventSource): Promise<number> {
  let written = 0;

  for (;;) {
    const batch = await backfillReceiptDocuments(source);

    if (batch === 0) return written;
    written += batch;
  }
}

async function main(): Promise<void> {
  await warmPool();
  console.log(`# Receipt bodies to documents: mode=${COMMIT ? "COMMIT" : "DRY"}`);
  const before = await report("before");

  if (!COMMIT) {
    console.log("  (pass --commit to write the documents)");

    return;
  }

  if (before === 0) return;

  for (const source of INBOUND_EVENT_SOURCES) {
    console.log(`  ${source}: wrote ${await drain(source)} documents`);
  }

  const after = await report("after");

  // A row that failed is logged by the backfill. Rerun after the fault is fixed.
  if (after > 0) process.exitCode = 1;
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
