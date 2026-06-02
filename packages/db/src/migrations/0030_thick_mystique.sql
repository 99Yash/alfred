DROP INDEX "briefings_user_date_idx";--> statement-breakpoint
DROP INDEX "briefings_user_date_desc_idx";--> statement-breakpoint
ALTER TABLE "briefings" ADD COLUMN "slot" text DEFAULT 'morning' NOT NULL;--> statement-breakpoint
ALTER TABLE "briefings" ADD COLUMN "watermark_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "briefings" ADD COLUMN "send_decision" text;--> statement-breakpoint
ALTER TABLE "briefings" ADD COLUMN "gate_reason" text;--> statement-breakpoint
ALTER TABLE "briefings" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "briefings_user_date_slot_idx" ON "briefings" USING btree ("user_id","briefing_date","slot");--> statement-breakpoint
CREATE INDEX "briefings_watermark_idx" ON "briefings" USING btree ("user_id","slot","watermark_at") WHERE "briefings"."status" in ('sent', 'suppressed');--> statement-breakpoint
CREATE INDEX "briefings_user_date_desc_idx" ON "briefings" USING btree ("user_id","briefing_date" DESC NULLS LAST,"slot");