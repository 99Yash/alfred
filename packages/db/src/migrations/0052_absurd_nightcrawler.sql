CREATE TABLE "observation_family_heads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"family_key" text NOT NULL,
	"head_observation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "active_projection_versions" DROP CONSTRAINT "active_projection_versions_active_run_id_projection_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "observation_family_heads" ADD CONSTRAINT "observation_family_heads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_family_heads" ADD CONSTRAINT "observation_family_heads_head_observation_id_observations_id_fk" FOREIGN KEY ("head_observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "observation_family_heads_unique_idx" ON "observation_family_heads" USING btree ("user_id","family_key");--> statement-breakpoint
CREATE INDEX "observation_family_heads_obs_idx" ON "observation_family_heads" USING btree ("head_observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_runs_active_fk_idx" ON "projection_runs" USING btree ("user_id","projection_name","projection_version","id");--> statement-breakpoint
ALTER TABLE "active_projection_versions" ADD CONSTRAINT "active_projection_versions_run_fk" FOREIGN KEY ("user_id","projection_name","active_version","active_run_id") REFERENCES "public"."projection_runs"("user_id","projection_name","projection_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_supersedes_id_entity_identities_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."entity_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_nodes" ADD CONSTRAINT "entity_nodes_supersedes_entity_id_entity_nodes_id_fk" FOREIGN KEY ("supersedes_entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_supersedes_observation_id_observations_id_fk" FOREIGN KEY ("supersedes_observation_id") REFERENCES "public"."observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_identities_supersedes_idx" ON "entity_identities" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "observations_supersedes_idx" ON "observations" USING btree ("supersedes_observation_id");--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_no_self_supersede" CHECK ("entity_identities"."supersedes_id" IS NULL OR "entity_identities"."supersedes_id" <> "entity_identities"."id");--> statement-breakpoint
ALTER TABLE "entity_nodes" ADD CONSTRAINT "entity_nodes_no_self_supersede" CHECK ("entity_nodes"."supersedes_entity_id" IS NULL OR "entity_nodes"."supersedes_entity_id" <> "entity_nodes"."id");--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_no_self_supersede" CHECK ("observations"."supersedes_observation_id" IS NULL OR "observations"."supersedes_observation_id" <> "observations"."id");