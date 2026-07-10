ALTER TABLE "api_call_log" ADD COLUMN "cache_write_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_prices" ADD COLUMN "cache_write_input_per_mtok" numeric(12, 6);