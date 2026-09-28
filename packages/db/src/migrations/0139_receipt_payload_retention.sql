CREATE INDEX "event_receipts_payload_live_idx" ON "event_receipts" USING btree ("delivered_at") WHERE "event_receipts"."payload" IS NOT NULL;
--> statement-breakpoint
-- Payload retention for `event_receipts`: the receipt outlives its body.
--
-- The table is append-only by trigger (migration 0134, issue #1177) and blocks
-- UPDATE of every evidence column including `payload`. That guard is doing its
-- job, and this migration does not weaken it: it permits exactly one new
-- transition, `payload` non-NULL -> NULL, and refuses every other mutation of
-- the column (a NULL being filled back in, or one body replaced by another).
--
-- Why the body and not the row. Everything that later depends on a receipt
-- lives in a small column and outlives a release:
--
--   (provider, provider_delivery_id)  the UNIQUE index that makes redelivery a
--                                     no-op via onConflictDoNothing
--   history_id                        the cursor `loadHighestReceiptHistoryId`
--                                     MAXes for Gmail gap detection
--   delivered_at / processing_status  the processing audit (ADR-0090)
--   payload_hash                      evidence a body was verified
--
-- `payload` is 100 MB of the table's 135 MB at an average 3,770 bytes a row,
-- so the body is the expensive part and the receipt is the load-bearing part,
-- and only the body expires.
--
-- READERS OF `payload`, because "nothing reads it retroactively" was the claim
-- this migration exists to replace, and naming only some of them repeats the
-- error. Enumerated 2026-09-28. What each does when the body is gone is stated
-- alongside it, because they do not all fail soft.
--
--   1. `writeReceiptDocument` (`connections/ingestion/receipt-document.ts`),
--      on the INSERT path, copying the body into `documents.raw`. Unaffected: it
--      runs in the same transaction that inserts the receipt.
--   2. `backfillReceiptDocuments`
--      (`connections/ingestion/receipt-corpus-backfill.ts`), on a 10-minute
--      tick, oldest-first, for a receipt that has no corpus document yet. This
--      one does NOT fail soft. `describe(kind, payload)` is typed
--      `(string, unknown) => InboundDescription` and never refuses a null, so a
--      released receipt still yields a document — a hollow one, with `raw = NULL`
--      and a body flattened from nothing. The `notExists` filter then stops
--      selecting it, so the real corpus copy is never recovered. A release must
--      therefore never outrun this backfill.
--   3. The object-state fold, `activity-consumer.ts:105`, reading the body at
--      deliver time for one receipt by id. Unaffected in practice because the
--      fold runs before the receipt completes and the reaper releases only
--      `completed` ones (item 02) — not because the row is young, since a
--      redelivery can reach a non-`completed` receipt of any age.
--   4. `gatherIntegrationActivity` (`briefings/gather.ts:747`), reached from
--      BOTH `gatherBriefing` (`gather.ts:591`) and the `get_day_shape` tool, over
--      a `sinceIngestedAt` -> now window. Past the window this reports a WRONG
--      FACT, not a cosmetic one: `action` lives only in the expiring body, and
--      `describeGithubActivity` (`github-description.ts:81`) derives
--      `status: "resolved"` from `action === "closed"`. With no body a MERGED PR
--      falls to the `?? "open"` default and reports `PR #? updated`, status
--      `open` — the opposite of what happened. `get_day_shape` then hands the
--      briefing agent that status, and its own tool contract says never to call
--      a day `quiet` when the volume is `busy` or `normal`; a merged PR read as
--      open is the same class of error. Queued as a behaviour fix in its own
--      right, not fixed by this comment. The `seenDeployments` collapse is also
--      lost (the #1167 fix for "one machine relay reads as several units of the
--      user's day"), which overstates the volume on top of the wrong status.
--   5. `backfill-object-state-github-committed.ts:48`, replaying EVERY stored
--      github `pull_request` body to rebuild `integration_objects`. `safeParse`
--      fails on a null, so released rows are skipped SILENTLY, and a rebuild
--      from receipts therefore covers only the retention window — the cost that
--      matters. Nothing recovers it: the corpus document holds a second copy of
--      the body, but no reader rebuilds object state from `documents.raw`, and
--      `objectStateStore.applyEvent` takes a payload as an argument rather than
--      reading one. `integration_objects` is rebuildable from history only while
--      that history is still inside the window.
--
-- Not readers, checked and excluded: `outbox-relay.ts` and `replay.ts` read
-- `events_outbox.payload`, a different table; `verified-pull/driver.ts:273`
-- passes an in-memory minted body, never a stored one.
--
-- A question about an old message is still answered from `documents`/`chunks`
-- (which dedup independently on (user_id, source, source_id) and are not
-- pruned) or from the live Gmail API through the integration tools. That is not
-- the same as rebuilding a projection: item 5 is a rebuild, and it is the one
-- that stops working.
--
-- Deliberately NOT a row delete. Receipts are never deleted DIRECTLY: the guard
-- below refuses that at `pg_trigger_depth() = 1`, and the `pg_trigger_depth() > 1`
-- arm is the FK cascade from a `user` or `integration_credentials` wipe, which is
-- intended.
-- Deleting rows for retention would forfeit the dedup index and the gap cursor,
-- and a provider redelivering an event older than the window would then be
-- ingested as new — a second triage email, a second reply. Nulling the body
-- makes that impossible rather than merely unlikely, because the unique key
-- survives.
--
-- The age policy is NOT in this trigger. This permits the transition; the
-- window belongs to the reaper that performs it, so the rule lives in one place
-- and can be changed without a migration.
--
-- The partial index above is the reaper's: it makes expiry an index-driven scan
-- whose size tracks the LIVE BODIES rather than the age of the table, since a
-- receipt leaves the index as soon as its body is released. Not exactly the
-- retention window, because the reaper (item 02) is what restricts itself to
-- `completed` receipts — nothing in this migration enforces that, so a reaper
-- written without the predicate would keep a failed receipt's body and its
-- index entry.
CREATE OR REPLACE FUNCTION event_receipts_guard_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'event_receipts is append-only: DELETE rejected (issue #1177)';
  END IF;

  -- The one permitted UPDATE: dropping an expired body. Forward-only in the
  -- sense that a body can be released but never written or replaced, so the
  -- guard still refuses a correction that would rewrite what was delivered.
  IF OLD.payload IS DISTINCT FROM NEW.payload THEN
    IF NOT (OLD.payload IS NOT NULL AND NEW.payload IS NULL) THEN
      RAISE EXCEPTION 'event_receipts payload is write-once: only expiry to NULL is permitted (issue #1177)';
    END IF;
  END IF;

  -- Lifecycle columns the delivery job owns (`markProcessed` in
  -- `inbound-deliver.ts`): processing_status / processed_at / updated_at.
  -- Every other column is evidence or identity and must not change.
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.provider_delivery_id IS DISTINCT FROM NEW.provider_delivery_id
    OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.raw_kind IS DISTINCT FROM NEW.raw_kind
    OR OLD.history_id IS DISTINCT FROM NEW.history_id
    OR OLD.verification_result IS DISTINCT FROM NEW.verification_result
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'event_receipts evidence is immutable: only processing_status/processed_at/updated_at may change (issue #1177)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
