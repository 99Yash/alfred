ALTER TABLE "entity_co_occurrence" DROP CONSTRAINT "entity_co_occurrence_a_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" DROP CONSTRAINT "entity_co_occurrence_b_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_edges" DROP CONSTRAINT "entity_edges_from_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_edges" DROP CONSTRAINT "entity_edges_to_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_identities" DROP CONSTRAINT "entity_identities_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_profiles" DROP CONSTRAINT "entity_profiles_entity_id_entity_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "observation_family_heads" DROP CONSTRAINT "observation_family_heads_head_observation_id_observations_id_fk";
--> statement-breakpoint
ALTER TABLE "projection_cursors" DROP CONSTRAINT "projection_cursors_projection_run_id_projection_runs_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_nodes_user_fk_idx" ON "entity_nodes" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "observations_family_member_fk_idx" ON "observations" USING btree ("user_id","family_key","id");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_a_fk" FOREIGN KEY ("user_id","a_entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_b_fk" FOREIGN KEY ("user_id","b_entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_from_fk" FOREIGN KEY ("user_id","from_entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_to_fk" FOREIGN KEY ("user_id","to_entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_entity_fk" FOREIGN KEY ("user_id","entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_entity_fk" FOREIGN KEY ("user_id","entity_id") REFERENCES "public"."entity_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_family_heads" ADD CONSTRAINT "observation_family_heads_obs_fk" FOREIGN KEY ("user_id","family_key","head_observation_id") REFERENCES "public"."observations"("user_id","family_key","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_cursors" ADD CONSTRAINT "projection_cursors_run_fk" FOREIGN KEY ("user_id","projection_name","projection_version","projection_run_id") REFERENCES "public"."projection_runs"("user_id","projection_name","projection_version","id") ON DELETE cascade ON UPDATE no action;
