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
CREATE UNIQUE INDEX "workflows_id_user_idx" ON "workflows" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_workflow_owner_fk" FOREIGN KEY ("workflow_id","user_id") REFERENCES "public"."workflows"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_workflow_id_idx" ON "workflow_revisions" USING btree ("workflow_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_id_user_idx" ON "workflow_revisions" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_number_idx" ON "workflow_revisions" USING btree ("workflow_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_run_idx" ON "workflow_revisions" USING btree ("workflow_id","created_by_run_id") WHERE "workflow_revisions"."created_by_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workflow_revision_owner_fk" FOREIGN KEY ("workflow_revision_id","user_id") REFERENCES "public"."workflow_revisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_current_revision_fk" FOREIGN KEY ("id","current_revision_id") REFERENCES "public"."workflow_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_published_revision_fk" FOREIGN KEY ("id","published_revision_id") REFERENCES "public"."workflow_revisions"("workflow_id","id") ON DELETE no action ON UPDATE no action;
