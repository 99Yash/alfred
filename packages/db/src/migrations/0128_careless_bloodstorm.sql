CREATE TABLE "shared_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_thread_id" text NOT NULL,
	"url_slug" text NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb NOT NULL,
	"artifacts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "shared_threads" ADD CONSTRAINT "shared_threads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_threads" ADD CONSTRAINT "shared_threads_source_thread_id_chat_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_threads_url_slug_idx" ON "shared_threads" USING btree ("url_slug");--> statement-breakpoint
CREATE INDEX "shared_threads_source_thread_idx" ON "shared_threads" USING btree ("source_thread_id","created_at");--> statement-breakpoint
CREATE INDEX "shared_threads_user_idx" ON "shared_threads" USING btree ("user_id");