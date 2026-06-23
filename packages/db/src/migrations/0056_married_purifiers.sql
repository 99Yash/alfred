ALTER TABLE "entity_co_occurrence" DROP CONSTRAINT "entity_co_occurrence_run_fk";
--> statement-breakpoint
ALTER TABLE "entity_edges" DROP CONSTRAINT "entity_edges_run_fk";
--> statement-breakpoint
ALTER TABLE "entity_profiles" DROP CONSTRAINT "entity_profiles_run_fk";
--> statement-breakpoint
DROP INDEX "projection_runs_version_fk_idx";--> statement-breakpoint
DROP INDEX "entity_co_occurrence_pair_idx";--> statement-breakpoint
DROP INDEX "entity_edges_unique_idx";--> statement-breakpoint
DROP INDEX "entity_profiles_version_idx";--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD COLUMN "projection_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD COLUMN "projection_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD COLUMN "projection_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_run_fk" FOREIGN KEY ("user_id","projection_name","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_name","projection_version","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_run_fk" FOREIGN KEY ("user_id","projection_name","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_name","projection_version","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_run_fk" FOREIGN KEY ("user_id","projection_name","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_name","projection_version","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_co_occurrence_pair_idx" ON "entity_co_occurrence" USING btree ("user_id","projection_name","projection_version","a_entity_id","b_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_edges_unique_idx" ON "entity_edges" USING btree ("user_id","projection_name","projection_version","relation_type","from_entity_id","to_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_profiles_version_idx" ON "entity_profiles" USING btree ("user_id","projection_name","projection_version","entity_id");--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_no_self_relation" CHECK ("entity_edges"."from_entity_id" <> "entity_edges"."to_entity_id");