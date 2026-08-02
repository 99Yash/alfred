-- The original workflow-revision migration also reached development databases
-- under index 0089. Converge that shape without replacing live workflow data.
CREATE TABLE IF NOT EXISTS "workflow_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"content_hash" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"brief" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"allowed_integrations" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"allowed_tools" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authoring_proposal" jsonb,
	"created_by_run_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "workflow_revision_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "current_revision_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "published_revision_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "blocked" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflows_id_user_idx" ON "workflows" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "workflow_revisions" DROP CONSTRAINT IF EXISTS "workflow_revisions_workflow_id_workflows_id_fk";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_revisions_workflow_id_idx" ON "workflow_revisions" USING btree ("workflow_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_revisions_id_user_idx" ON "workflow_revisions" USING btree ("id","user_id");--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_revisions_user_id_user_id_fk' AND conrelid = 'workflow_revisions'::regclass) THEN
		ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_revisions_workflow_owner_fk' AND conrelid = 'workflow_revisions'::regclass) THEN
		ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_workflow_owner_fk" FOREIGN KEY ("workflow_id","user_id") REFERENCES "public"."workflows"("id","user_id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_workflow_revision_owner_fk' AND conrelid = 'agent_runs'::regclass) THEN
		ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workflow_revision_owner_fk" FOREIGN KEY ("workflow_revision_id","user_id") REFERENCES "public"."workflow_revisions"("id","user_id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_current_revision_fk' AND conrelid = 'workflows'::regclass) THEN
		ALTER TABLE "workflows" ADD CONSTRAINT "workflows_current_revision_fk" FOREIGN KEY ("id","current_revision_id") REFERENCES "public"."workflow_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_published_revision_fk' AND conrelid = 'workflows'::regclass) THEN
		ALTER TABLE "workflows" ADD CONSTRAINT "workflows_published_revision_fk" FOREIGN KEY ("id","published_revision_id") REFERENCES "public"."workflow_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_revisions_number_idx" ON "workflow_revisions" USING btree ("workflow_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_revisions_run_idx" ON "workflow_revisions" USING btree ("workflow_id","created_by_run_id") WHERE "workflow_revisions"."created_by_run_id" IS NOT NULL;
