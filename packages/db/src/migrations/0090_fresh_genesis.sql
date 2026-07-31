CREATE TABLE "workflow_revisions" (
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
ALTER TABLE "agent_runs" ADD COLUMN "workflow_revision_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "current_revision_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "published_revision_id" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "blocked" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_number_idx" ON "workflow_revisions" USING btree ("workflow_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_run_idx" ON "workflow_revisions" USING btree ("workflow_id","created_by_run_id") WHERE "workflow_revisions"."created_by_run_id" IS NOT NULL;