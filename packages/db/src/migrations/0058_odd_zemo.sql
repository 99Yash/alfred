DROP INDEX "entity_co_occurrence_weight_idx";--> statement-breakpoint
DROP INDEX "entity_edges_from_idx";--> statement-breakpoint
DROP INDEX "entity_edges_to_idx";--> statement-breakpoint
CREATE INDEX "entity_co_occurrence_weight_idx" ON "entity_co_occurrence" USING btree ("user_id","projection_name","projection_version","weight");--> statement-breakpoint
CREATE INDEX "entity_edges_from_idx" ON "entity_edges" USING btree ("user_id","projection_name","projection_version","from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_edges_to_idx" ON "entity_edges" USING btree ("user_id","projection_name","projection_version","to_entity_id");