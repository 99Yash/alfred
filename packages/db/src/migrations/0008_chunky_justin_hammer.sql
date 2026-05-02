CREATE TABLE "email_triage" (
	"document_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"confidence" real NOT NULL,
	"rationale" text,
	"model" text NOT NULL,
	"applied_label_id" text,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_triage_user_category_idx" ON "email_triage" USING btree ("user_id","category","classified_at");--> statement-breakpoint
CREATE INDEX "email_triage_user_classified_idx" ON "email_triage" USING btree ("user_id","classified_at");