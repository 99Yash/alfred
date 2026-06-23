CREATE INDEX "entity_co_occurrence_run_idx" ON "entity_co_occurrence" USING btree ("user_id","projection_run_id");--> statement-breakpoint
CREATE INDEX "entity_edges_run_idx" ON "entity_edges" USING btree ("user_id","projection_run_id");--> statement-breakpoint
CREATE INDEX "entity_profiles_run_idx" ON "entity_profiles" USING btree ("user_id","projection_run_id");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_family_count_lte_count" CHECK ("entity_co_occurrence"."family_count" <= "entity_co_occurrence"."count");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_weight_requires_count" CHECK ("entity_co_occurrence"."weight" = 0 OR "entity_co_occurrence"."count" > 0);