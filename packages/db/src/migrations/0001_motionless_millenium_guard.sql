CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "replicache_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_group_id" text NOT NULL,
	"last_mutation_id" integer DEFAULT 0 NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replicache_client_group" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"cvr_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replicache_client" ADD CONSTRAINT "replicache_client_client_group_id_replicache_client_group_id_fk" FOREIGN KEY ("client_group_id") REFERENCES "public"."replicache_client_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replicache_client_group" ADD CONSTRAINT "replicache_client_group_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replicache_client_group_idx" ON "replicache_client" USING btree ("client_group_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_row_version() RETURNS TRIGGER AS $$
BEGIN
  NEW.row_version = COALESCE(OLD.row_version, 0) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notes_row_version_bump ON "notes";
--> statement-breakpoint
CREATE TRIGGER notes_row_version_bump
BEFORE UPDATE ON "notes"
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION bump_row_version();