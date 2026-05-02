CREATE TABLE "memory_extraction_status" (
	"document_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"last_extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" text,
	"proposed_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_extraction_status" ADD CONSTRAINT "memory_extraction_status_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_status" ADD CONSTRAINT "memory_extraction_status_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_extraction_status_user_idx" ON "memory_extraction_status" USING btree ("user_id","last_extracted_at");