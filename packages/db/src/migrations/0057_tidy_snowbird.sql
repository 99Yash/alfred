DROP INDEX "entity_identities_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identities_active_unique_idx" ON "entity_identities" USING btree ("user_id","kind","value") WHERE "entity_identities"."valid_until" IS NULL;--> statement-breakpoint
ALTER TABLE "active_projection_versions" ADD CONSTRAINT "active_projection_versions_version_positive" CHECK ("active_projection_versions"."active_version" >= 1);--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_version_positive" CHECK ("entity_co_occurrence"."projection_version" >= 1);--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_version_positive" CHECK ("entity_edges"."projection_version" >= 1);--> statement-breakpoint
ALTER TABLE "entity_nodes" ADD CONSTRAINT "entity_nodes_id_shape" CHECK ("entity_nodes"."id" ~ '^ent_[a-z2-7]{26}$');--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_version_positive" CHECK ("entity_profiles"."projection_version" >= 1);--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_schema_version_positive" CHECK ("observations"."schema_version" >= 1);--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_reducer_version_positive" CHECK ("observations"."reducer_version" >= 1);--> statement-breakpoint
ALTER TABLE "projection_cursors" ADD CONSTRAINT "projection_cursors_version_positive" CHECK ("projection_cursors"."projection_version" >= 1);--> statement-breakpoint
ALTER TABLE "projection_runs" ADD CONSTRAINT "projection_runs_version_positive" CHECK ("projection_runs"."projection_version" >= 1);