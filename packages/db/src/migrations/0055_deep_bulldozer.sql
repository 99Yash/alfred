ALTER TABLE "entity_co_occurrence" DROP CONSTRAINT "entity_co_occurrence_run_fk";
--> statement-breakpoint
ALTER TABLE "entity_edges" DROP CONSTRAINT "entity_edges_run_fk";
--> statement-breakpoint
ALTER TABLE "entity_profiles" DROP CONSTRAINT "entity_profiles_run_fk";
--> statement-breakpoint
DROP INDEX "projection_runs_user_fk_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "projection_runs_version_fk_idx" ON "projection_runs" USING btree ("user_id","projection_version","id");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_run_fk" FOREIGN KEY ("user_id","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_version","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_run_fk" FOREIGN KEY ("user_id","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_version","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_run_fk" FOREIGN KEY ("user_id","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_version","id") ON DELETE cascade ON UPDATE no action;
