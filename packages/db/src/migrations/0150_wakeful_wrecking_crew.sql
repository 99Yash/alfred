ALTER TABLE "todo_events" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "authority_ref" jsonb;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "name_before" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "name_after" text;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "due_date_before" date;--> statement-breakpoint
ALTER TABLE "todo_events" ADD COLUMN "due_date_after" date;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "attribution" jsonb;--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_authority_valid" CHECK (("todo_events"."authority" IS NULL) OR ("todo_events"."authority" IN ('instruction', 'policy', 'user_direct', 'user_request')));--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_cause_valid" CHECK (("todo_events"."cause" IS NULL) OR ("todo_events"."cause" IN ('cleared', 'completed', 'created', 'dismissed', 'edited', 'payment_matched', 'promoted', 'reopened', 'reply_detected', 'sender_suppressed', 'suggested')));--> statement-breakpoint
-- ADR-0115 slice 1 (#1586). Each todo write carries its attribution record in
-- "todos"."attribution". The triggers below copy it into "todo_events" and
-- fail a write that has no record. A missing actor is never recorded as
-- 'system' (rule 2): the old COALESCE(resolved_by, 'system') fallback is gone.
DROP TRIGGER IF EXISTS todos_transition_history ON "todos";
--> statement-breakpoint
DROP FUNCTION IF EXISTS todos_log_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION todos_check_attribution(rec jsonb) RETURNS void AS $$
BEGIN
  IF rec IS NULL OR jsonb_typeof(rec) <> 'object' THEN
    RAISE EXCEPTION 'todos write has no attribution record (ADR-0115 rule 2)';
  END IF;
  IF rec->>'actor' IS NULL THEN
    RAISE EXCEPTION 'todos write has no actor (ADR-0115 rule 2)';
  END IF;
  IF rec->>'cause' IS NULL THEN
    RAISE EXCEPTION 'todos write by % has no cause (ADR-0115 rule 3)', rec->>'actor';
  END IF;
  IF rec->>'actor' = 'agent' AND (rec->>'runId' IS NULL OR rec->>'toolCallId' IS NULL) THEN
    RAISE EXCEPTION 'agent todos write has no run id or tool call id (ADR-0115)';
  END IF;
  -- An agent write may still lack an authority until #1588 checks it at dispatch.
  IF rec->>'actor' <> 'agent' AND rec->>'authority' IS NULL THEN
    RAISE EXCEPTION 'todos write by % has no authority (ADR-0115)', rec->>'actor';
  END IF;
  IF rec->>'authority' IS NOT NULL AND rec->>'authority' <> 'user_direct'
     AND jsonb_typeof(rec->'authorityRef') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'todos write under % has no authority ref (ADR-0115)', rec->>'authority';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION todos_log_creation() RETURNS TRIGGER AS $$
DECLARE
  rec jsonb := NEW.attribution;
BEGIN
  PERFORM todos_check_attribution(rec);
  -- ADR-0116 rule 4 reads the creator from this event, so it must match created_by.
  IF rec->>'actor' IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'todos creation actor % does not match created_by %', rec->>'actor', NEW.created_by;
  END IF;
  INSERT INTO "todo_events" (
    "id", "todo_id", "user_id", "from_status", "to_status", "actor",
    "authority", "authority_ref", "run_id", "tool_call_id", "cause", "note",
    "name_before", "name_after", "due_date_before", "due_date_after"
  ) VALUES (
    'tev_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12),
    NEW.id, NEW.user_id, NULL, NEW.status, rec->>'actor',
    rec->>'authority', NULLIF(rec->'authorityRef', 'null'::jsonb), rec->>'runId', rec->>'toolCallId',
    rec->>'cause', rec->>'note',
    NULL, NEW.name, NULL, NEW.due_date
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER todos_creation_history
  AFTER INSERT ON "todos"
  FOR EACH ROW EXECUTE FUNCTION todos_log_creation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION todos_log_change() RETURNS TRIGGER AS $$
DECLARE
  rec jsonb := NEW.attribution;
  name_changed boolean := OLD.name IS DISTINCT FROM NEW.name;
  due_changed boolean := OLD.due_date IS DISTINCT FROM NEW.due_date;
BEGIN
  -- An AFTER INSERT trigger cannot clear the column, so the creation record
  -- stays on the row until the first update. It never attributes a change.
  IF rec IS NOT DISTINCT FROM OLD.attribution THEN
    rec := NULL;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status OR name_changed OR due_changed THEN
    PERFORM todos_check_attribution(rec);
    -- BEFORE UPDATE, so the record can be cleared. The todo row already
    -- exists, and a later failure in this statement rolls the event back.
    INSERT INTO "todo_events" (
      "id", "todo_id", "user_id", "from_status", "to_status", "actor",
      "authority", "authority_ref", "run_id", "tool_call_id", "cause", "note",
      "name_before", "name_after", "due_date_before", "due_date_after"
    ) VALUES (
      'tev_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12),
      NEW.id, NEW.user_id, OLD.status, NEW.status, rec->>'actor',
      rec->>'authority', NULLIF(rec->'authorityRef', 'null'::jsonb), rec->>'runId', rec->>'toolCallId',
      rec->>'cause', rec->>'note',
      CASE WHEN name_changed THEN OLD.name END, CASE WHEN name_changed THEN NEW.name END,
      CASE WHEN due_changed THEN OLD.due_date END, CASE WHEN due_changed THEN NEW.due_date END
    );
  END IF;
  -- Null at rest, so a record never carries over to a later write.
  NEW.attribution := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER todos_change_history
  BEFORE UPDATE ON "todos"
  FOR EACH ROW EXECUTE FUNCTION todos_log_change();
