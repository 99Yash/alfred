DROP INDEX IF EXISTS "workflow_revisions_run_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_run_idx" ON "workflow_revisions" USING btree ("workflow_id","created_by_run_id","content_hash") WHERE "workflow_revisions"."created_by_run_id" IS NOT NULL;
