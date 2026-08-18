CREATE TABLE "event_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"history_id" text,
	"verification_result" text DEFAULT 'oidc_valid' NOT NULL,
	"payload_hash" text,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_credential_id_integration_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."integration_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_receipts_dedup_idx" ON "event_receipts" USING btree ("provider","provider_delivery_id");--> statement-breakpoint
CREATE INDEX "event_receipts_credential_idx" ON "event_receipts" USING btree ("credential_id","delivered_at");--> statement-breakpoint
CREATE INDEX "event_receipts_user_idx" ON "event_receipts" USING btree ("user_id","provider","delivered_at");