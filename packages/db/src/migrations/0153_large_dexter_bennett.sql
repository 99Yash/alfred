CREATE TABLE "standing_instruction_set_revisions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "email_triage" ADD COLUMN "model_verdict" jsonb;--> statement-breakpoint
ALTER TABLE "email_triage" ADD COLUMN "instruction_evaluation" jsonb;--> statement-breakpoint
ALTER TABLE "standing_instruction_set_revisions" ADD CONSTRAINT "standing_instruction_set_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;