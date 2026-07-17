ALTER TABLE "entity_identities" DROP CONSTRAINT "entity_identities_supersedes_id_entity_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_nodes" DROP CONSTRAINT "entity_nodes_supersedes_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "observations" DROP CONSTRAINT "observations_supersedes_observation_id_observations_id_fk";
--> statement-breakpoint
DROP INDEX "observations_dedup_idx";--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD COLUMN "projection_run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD COLUMN "projection_run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD COLUMN "projection_run_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identities_user_fk_idx" ON "entity_identities" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_runs_user_fk_idx" ON "projection_runs" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_run_fk" FOREIGN KEY ("user_id","projection_run_id") REFERENCES "public"."projection_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_run_fk" FOREIGN KEY ("user_id","projection_run_id") REFERENCES "public"."projection_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_supersedes_fk" FOREIGN KEY ("user_id","supersedes_id") REFERENCES "public"."entity_identities"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_nodes" ADD CONSTRAINT "entity_nodes_supersedes_fk" FOREIGN KEY ("user_id","supersedes_entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_run_fk" FOREIGN KEY ("user_id","projection_run_id") REFERENCES "public"."projection_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_supersedes_fk" FOREIGN KEY ("user_id","family_key","supersedes_observation_id") REFERENCES "public"."observations"("user_id","family_key","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "observations_no_fork_idx" ON "observations" USING btree ("user_id","family_key","supersedes_observation_id") WHERE "observations"."supersedes_observation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "observations_dedup_idx" ON "observations" USING btree ("user_id","family_key","evidence_hash");--> statement-breakpoint
ALTER TABLE "observations" DROP COLUMN "dedup_key";
