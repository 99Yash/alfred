CREATE TABLE "chat_attachment_representations" (
	"attachment_id" text NOT NULL,
	"representation_version" integer NOT NULL,
	"status" text NOT NULL,
	"representation" jsonb,
	"provider" text,
	"model" text,
	"estimated_cost_microusd" integer,
	"failure_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp,
	CONSTRAINT "chat_attachment_representations_attachment_id_representation_version_pk" PRIMARY KEY("attachment_id","representation_version"),
	CONSTRAINT "chat_attachment_representations_version_chk" CHECK ("chat_attachment_representations"."representation_version" > 0),
	CONSTRAINT "chat_attachment_representations_cost_chk" CHECK ("chat_attachment_representations"."estimated_cost_microusd" IS NULL OR "chat_attachment_representations"."estimated_cost_microusd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_attachment_representations" ADD CONSTRAINT "chat_attachment_representations_attachment_id_chat_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."chat_attachments"("id") ON DELETE cascade ON UPDATE no action;