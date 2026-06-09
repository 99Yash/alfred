DROP INDEX "webhook_events_user_type_idx";--> statement-breakpoint
CREATE INDEX "webhook_events_user_provider_idx" ON "webhook_events" USING btree ("user_id","provider","delivered_at");