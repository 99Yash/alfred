CREATE TABLE "email_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"template" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_idem_idx" ON "email_sends" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "email_sends_user_kind_idx" ON "email_sends" USING btree ("user_id","kind","created_at");