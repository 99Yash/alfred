CREATE TABLE "events_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "events_outbox" ADD CONSTRAINT "events_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_outbox_user_id_idx" ON "events_outbox" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "events_outbox_unpublished_idx" ON "events_outbox" USING btree ("id") WHERE "events_outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION events_outbox_notify() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('events_outbox_new', '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS events_outbox_notify_trigger ON "events_outbox";
--> statement-breakpoint
CREATE TRIGGER events_outbox_notify_trigger
AFTER INSERT ON "events_outbox"
FOR EACH ROW
EXECUTE FUNCTION events_outbox_notify();