CREATE TABLE "document_asks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"requested_kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"asked_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_carrier_message_id" text,
	"resolved_attachment_document_id" text,
	"resolved_attachment_id" text,
	"resolved_attachment_content_hash" text,
	"resolved_attachment_format" text,
	"resolved_content_kind" text,
	"resolved_evidence_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp,
	CONSTRAINT "document_asks_kind_valid" CHECK ("document_asks"."requested_kind" IN ('portfolio', 'resume')),
	CONSTRAINT "document_asks_status_valid" CHECK ("document_asks"."status" IN ('active', 'resolved')),
	CONSTRAINT "document_asks_resolution_coherent" CHECK ((
        "document_asks"."status" = 'active'
        AND "document_asks"."resolved_at" IS NULL
        AND "document_asks"."resolved_carrier_message_id" IS NULL
        AND "document_asks"."resolved_attachment_document_id" IS NULL
        AND "document_asks"."resolved_attachment_id" IS NULL
        AND "document_asks"."resolved_attachment_content_hash" IS NULL
        AND "document_asks"."resolved_attachment_format" IS NULL
        AND "document_asks"."resolved_content_kind" IS NULL
        AND "document_asks"."resolved_evidence_source" IS NULL
      ) OR (
        "document_asks"."status" = 'resolved'
        AND "document_asks"."resolved_at" IS NOT NULL
        AND "document_asks"."resolved_carrier_message_id" IS NOT NULL
        AND "document_asks"."resolved_carrier_message_id" <> ''
        AND "document_asks"."resolved_attachment_document_id" IS NOT NULL
        AND "document_asks"."resolved_attachment_document_id" <> ''
        AND "document_asks"."resolved_attachment_id" IS NOT NULL
        AND "document_asks"."resolved_attachment_id" <> ''
        AND "document_asks"."resolved_attachment_content_hash" IS NOT NULL
        AND "document_asks"."resolved_attachment_content_hash" <> ''
        AND "document_asks"."resolved_attachment_format" IS NOT NULL
        AND "document_asks"."resolved_attachment_format" IN ('document', 'pdf', 'spreadsheet', 'text')
        AND "document_asks"."resolved_content_kind" IS NOT NULL
        AND "document_asks"."resolved_evidence_source" = 'extracted_content'
      )),
	CONSTRAINT "document_asks_resolved_kind_matches" CHECK ("document_asks"."resolved_content_kind" IS NULL OR "document_asks"."resolved_content_kind" = "document_asks"."requested_kind")
);
--> statement-breakpoint
ALTER TABLE "email_triage" ADD COLUMN "document_ask" jsonb;--> statement-breakpoint
ALTER TABLE "document_asks" ADD CONSTRAINT "document_asks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_asks_source_identity_idx" ON "document_asks" USING btree ("user_id","account_id","source_message_id");--> statement-breakpoint
CREATE INDEX "document_asks_active_thread_idx" ON "document_asks" USING btree ("user_id","account_id","thread_id","status","requested_kind");