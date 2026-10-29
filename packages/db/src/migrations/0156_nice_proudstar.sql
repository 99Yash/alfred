CREATE TABLE "email_triage_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_thread_id" text NOT NULL,
	"document_id" text NOT NULL,
	"set_revision" integer NOT NULL,
	"previous" jsonb NOT NULL,
	"next" jsonb NOT NULL,
	"scopes" jsonb NOT NULL,
	"floor" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_triage_changes" ADD CONSTRAINT "email_triage_changes_triage_fk" FOREIGN KEY ("user_id","source_thread_id") REFERENCES "public"."email_triage"("user_id","source_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_triage_changes_thread_idx" ON "email_triage_changes" USING btree ("user_id","source_thread_id","changed_at");