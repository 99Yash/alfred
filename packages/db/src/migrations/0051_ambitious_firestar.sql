DROP INDEX "projection_cursors_unique_idx";--> statement-breakpoint
ALTER TABLE "observations" ALTER COLUMN "participants" SET DEFAULT '{"items":[],"recipientCount":0}'::jsonb;--> statement-breakpoint
ALTER TABLE "active_projection_versions" ADD COLUMN "active_run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_cursors" ADD COLUMN "projection_run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "projection_cursors" ADD COLUMN "projection_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "active_projection_versions" ADD CONSTRAINT "active_projection_versions_active_run_id_projection_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."projection_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_cursors" ADD CONSTRAINT "projection_cursors_projection_run_id_projection_runs_id_fk" FOREIGN KEY ("projection_run_id") REFERENCES "public"."projection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_projection_versions_run_idx" ON "active_projection_versions" USING btree ("user_id","active_run_id");--> statement-breakpoint
CREATE INDEX "projection_cursors_version_idx" ON "projection_cursors" USING btree ("user_id","projection_name","projection_version");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_runs_unique_idx" ON "projection_runs" USING btree ("user_id","projection_name","projection_version");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_cursors_unique_idx" ON "projection_cursors" USING btree ("user_id","projection_run_id","source");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_weight_nonnegative" CHECK ("entity_co_occurrence"."weight" >= 0);--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_count_nonnegative" CHECK ("entity_co_occurrence"."count" >= 0);--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_family_count_nonnegative" CHECK ("entity_co_occurrence"."family_count" >= 0);--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_weight_nonnegative" CHECK ("entity_edges"."weight" >= 0);--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_confidence_range" CHECK ("entity_edges"."confidence" >= 0 AND "entity_edges"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_confidence_range" CHECK ("entity_identities"."confidence" >= 0 AND "entity_identities"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "projection_sync_state" ADD CONSTRAINT "projection_sync_state_row_version_nonnegative" CHECK ("projection_sync_state"."row_version" >= 0);