CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"repo" text,
	"installation_id" text,
	"user_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD COLUMN "installation_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedup_idx" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_user_type_idx" ON "webhook_events" USING btree ("user_id","event_type","delivered_at");--> statement-breakpoint
CREATE INDEX "integration_credentials_installation_idx" ON "integration_credentials" USING btree ("installation_id");