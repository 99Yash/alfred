CREATE TABLE "drift_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" real NOT NULL,
	"window_label" text,
	"detail" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "drift_metrics" ADD CONSTRAINT "drift_metrics_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drift_metrics_user_metric_idx" ON "drift_metrics" USING btree ("user_id","metric","captured_at");