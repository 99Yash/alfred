CREATE TABLE "todo_events" (
	"id" text PRIMARY KEY NOT NULL,
	"todo_id" text NOT NULL,
	"user_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "todo_events_to_status_valid" CHECK ("todo_events"."to_status" IN ('cleared', 'dismissed', 'done', 'open', 'suggested')),
	CONSTRAINT "todo_events_from_status_valid" CHECK (("todo_events"."from_status" IS NULL) OR ("todo_events"."from_status" IN ('cleared', 'dismissed', 'done', 'open', 'suggested'))),
	CONSTRAINT "todo_events_actor_valid" CHECK ("todo_events"."actor" IN ('agent', 'system', 'user'))
);
--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "resolved_reason" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todo_events_todo_idx" ON "todo_events" USING btree ("todo_id","created_at");--> statement-breakpoint
CREATE INDEX "todo_events_user_idx" ON "todo_events" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_resolved_by_valid" CHECK (("todos"."resolved_by" IS NULL) OR ("todos"."resolved_by" IN ('agent', 'system', 'user')));
--> statement-breakpoint
-- #1177: DB-level append-only + immutability enforcement.
--
-- Boundary (documented, by design): these are triggers, so they fire for every
-- role including the table owner — unlike GRANT/REVOKE, which cannot separate
-- the app from its own writes on a single-role database (the app legitimately
-- UPDATES receipts' lifecycle columns and todos' status). Bypass requires
-- superuser `session_replication_role` or dropping the trigger, both outside
-- application reach. Corrections are new rows, never mutations.
CREATE OR REPLACE FUNCTION event_receipts_guard_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event_receipts is append-only: DELETE rejected (issue #1177)';
  END IF;
  -- Lifecycle columns the delivery job owns (`markProcessed` in
  -- `inbound-deliver.ts`): processing_status / processed_at / updated_at.
  -- Every other column is evidence or identity and must not change.
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.provider_delivery_id IS DISTINCT FROM NEW.provider_delivery_id
    OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.raw_kind IS DISTINCT FROM NEW.raw_kind
    OR OLD.history_id IS DISTINCT FROM NEW.history_id
    OR OLD.verification_result IS DISTINCT FROM NEW.verification_result
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'event_receipts evidence is immutable: only processing_status/processed_at/updated_at may change (issue #1177)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS event_receipts_append_only ON "event_receipts";
--> statement-breakpoint
CREATE TRIGGER event_receipts_append_only
  BEFORE UPDATE OR DELETE ON "event_receipts"
  FOR EACH ROW EXECUTE FUNCTION event_receipts_guard_evidence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION todo_events_guard_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'todo_events is append-only: % rejected (issue #1177)', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS todo_events_append_only ON "todo_events";
--> statement-breakpoint
CREATE TRIGGER todo_events_append_only
  BEFORE UPDATE OR DELETE ON "todo_events"
  FOR EACH ROW EXECUTE FUNCTION todo_events_guard_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION todos_guard_identity() RETURNS TRIGGER AS $$
DECLARE
  old_identity jsonb;
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.agent_run_id IS DISTINCT FROM NEW.agent_run_id
  THEN
    RAISE EXCEPTION 'todos identity is immutable: id/user_id/created_by/agent_run_id may not change (issue #1177)';
  END IF;
  -- Sources are append-only on identity refs: every OLD ref that is NOT a
  -- Gmail transport `thread` must still be present in NEW. Thread refs are
  -- transport (per-notification pointers the #355 cap evicts oldest-first),
  -- so they may come and go; identity refs name the loop itself.
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) INTO old_identity
  FROM jsonb_array_elements(COALESCE(OLD.sources, '[]'::jsonb)) AS elem
  WHERE NOT (elem->>'provider' = 'gmail' AND elem->>'kind' = 'thread');
  IF NOT (COALESCE(NEW.sources, '[]'::jsonb) @> old_identity) THEN
    RAISE EXCEPTION 'todos sources are append-only: identity refs may not be removed or replaced (issue #1177)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS todos_immutable_identity ON "todos";
--> statement-breakpoint
CREATE TRIGGER todos_immutable_identity
  BEFORE UPDATE ON "todos"
  FOR EACH ROW EXECUTE FUNCTION todos_guard_identity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION todos_log_transition() RETURNS TRIGGER AS $$
BEGIN
  -- Mint: attribute to the creator (created_by is user|agent, matching the
  -- actor vocabulary). Status-change: attribute to resolved_by; every
  -- production writer sets it, and the 'system' fallback keeps a missed
  -- writer visible (an unattributed row reads as system-owned) instead of
  -- failing the write.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "todo_events" ("id", "todo_id", "user_id", "from_status", "to_status", "actor", "reason")
    VALUES ('tev_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12), NEW.id, NEW.user_id, NULL, NEW.status, NEW.created_by, NULL);
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO "todo_events" ("id", "todo_id", "user_id", "from_status", "to_status", "actor", "reason")
    VALUES ('tev_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12), NEW.id, NEW.user_id, OLD.status, NEW.status, COALESCE(NEW.resolved_by, 'system'), NEW.resolved_reason);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS todos_transition_history ON "todos";
--> statement-breakpoint
CREATE TRIGGER todos_transition_history
  AFTER INSERT OR UPDATE OF "status" ON "todos"
  FOR EACH ROW EXECUTE FUNCTION todos_log_transition();