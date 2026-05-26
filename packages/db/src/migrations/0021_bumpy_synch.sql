CREATE TABLE "briefings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"briefing_date" date NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gather" jsonb NOT NULL,
	"breaking_summary" text DEFAULT '' NOT NULL,
	"full_briefing" jsonb NOT NULL,
	"model" text,
	"email_send_id" text,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_email_send_id_email_sends_id_fk" FOREIGN KEY ("email_send_id") REFERENCES "public"."email_sends"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "briefings_user_date_idx" ON "briefings" USING btree ("user_id","briefing_date");--> statement-breakpoint
CREATE INDEX "briefings_user_date_desc_idx" ON "briefings" USING btree ("user_id","briefing_date" DESC NULLS LAST);