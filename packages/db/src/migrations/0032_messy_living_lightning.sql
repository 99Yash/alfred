CREATE TABLE "sender_priors" (
	"user_id" text NOT NULL,
	"sender_key" text NOT NULL,
	"category_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_category" text,
	"display_name" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp,
	CONSTRAINT "sender_priors_user_id_sender_key_pk" PRIMARY KEY("user_id","sender_key")
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD COLUMN "persona" text;--> statement-breakpoint
ALTER TABLE "sender_priors" ADD CONSTRAINT "sender_priors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;