DROP TABLE "briefing_runs" CASCADE;--> statement-breakpoint
DROP TABLE "integration_object_relations" CASCADE;--> statement-breakpoint
DROP TABLE "style_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "projection_sync_state" CASCADE;--> statement-breakpoint
-- The smoke `echo-with-approval` recipe is no longer a builtin: the seeder no longer
-- seeds it, so a boot-seeded row would linger in the user-facing workflows list.
DELETE FROM "workflows" WHERE "slug" = 'echo-with-approval' AND "is_builtin" = true;