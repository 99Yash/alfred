CREATE TEMP TABLE "_event_run_duplicate_losers" ("id" text PRIMARY KEY) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO "_event_run_duplicate_losers" ("id")
SELECT "id"
FROM (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY
				"user_id",
				"workflow_slug",
				coalesce("trigger" ->> 'source', ''),
				coalesce("trigger" ->> 'type', ''),
				"trigger" ->> 'eventId',
				coalesce("trigger" -> 'payload' ->> 'reason', '')
			ORDER BY "created_at", "id"
		) AS "identity_rank"
	FROM "agent_runs"
	WHERE ("trigger" ->> 'kind') = 'event'
		AND ("trigger" ->> 'eventId') IS NOT NULL
		AND "status" NOT IN ('completed', 'failed', 'cancelled')
) AS "ranked"
WHERE "identity_rank" > 1;
--> statement-breakpoint
UPDATE "action_stagings"
SET
	"status" = 'rejected',
	"reject_reason" = 'duplicate event run cancelled during event identity migration',
	"decided_at" = now(),
	"row_version" = "row_version" + 1,
	"updated_at" = now()
WHERE "run_id" IN (SELECT "id" FROM "_event_run_duplicate_losers")
	AND "status" = 'pending'
	AND "requires_approval" = true;
--> statement-breakpoint
UPDATE "agent_runs"
SET
	"status" = 'cancelled',
	"wake_condition" = NULL,
	"error" = jsonb_build_object(
		'reason', 'duplicate_event_identity_migration',
		'cancelledAt', now()::text
	),
	"ended_at" = now(),
	"last_checkpoint_at" = now(),
	"updated_at" = now()
WHERE "id" IN (SELECT "id" FROM "_event_run_duplicate_losers");
--> statement-breakpoint
DROP INDEX "agent_runs_active_event_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_event_active_idx" ON "agent_runs" USING btree ("user_id","workflow_slug",coalesce("trigger" ->> 'source', ''),coalesce("trigger" ->> 'type', ''),("trigger" ->> 'eventId'),coalesce("trigger" -> 'payload' ->> 'reason', '')) WHERE ("agent_runs"."trigger" ->> 'kind') = 'event' AND ("agent_runs"."trigger" ->> 'eventId') IS NOT NULL AND "agent_runs"."status" NOT IN ('completed', 'failed', 'cancelled');
