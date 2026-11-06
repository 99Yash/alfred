CREATE TABLE "loop_verification_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"things" integer NOT NULL,
	"live_reads" integer NOT NULL,
	"facts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "loop_verification_runs" ADD CONSTRAINT "loop_verification_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loop_verification_runs_user_ran_idx" ON "loop_verification_runs" USING btree ("user_id","ran_at");