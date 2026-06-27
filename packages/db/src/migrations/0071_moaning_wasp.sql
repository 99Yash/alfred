ALTER TABLE "drift_metrics" ADD COLUMN "capture_key" text;--> statement-breakpoint
UPDATE "drift_metrics" SET "capture_key" = 'legacy:' || "id"::text WHERE "capture_key" IS NULL;--> statement-breakpoint
ALTER TABLE "drift_metrics" ALTER COLUMN "capture_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drift_metrics_user_metric_capture_key_idx" ON "drift_metrics" USING btree ("user_id","metric","capture_key");
