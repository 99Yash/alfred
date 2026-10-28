ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_unattributed_bare" CHECK (("todo_events"."cause" IS NOT NULL) OR ("todo_events"."authority" IS NULL AND "todo_events"."authority_ref" IS NULL AND "todo_events"."run_id" IS NULL AND "todo_events"."tool_call_id" IS NULL AND "todo_events"."note" IS NULL));--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_actor_authority_valid" CHECK (COALESCE(("todo_events"."cause" IS NULL)
        OR ("todo_events"."actor" = 'user' AND "todo_events"."authority" = 'user_direct')
        OR ("todo_events"."actor" = 'agent' AND ("todo_events"."authority" IS NULL OR "todo_events"."authority" <> 'user_direct'))
        OR ("todo_events"."actor" = 'system' AND "todo_events"."authority" IN ('instruction', 'policy')), false));--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_agent_action_valid" CHECK (COALESCE(("todo_events"."cause" IS NULL) OR CASE WHEN "todo_events"."actor" = 'agent'
        THEN length("todo_events"."run_id") > 0 AND length("todo_events"."tool_call_id") > 0
        ELSE "todo_events"."run_id" IS NULL AND "todo_events"."tool_call_id" IS NULL END, false));--> statement-breakpoint
ALTER TABLE "todo_events" ADD CONSTRAINT "todo_events_authority_ref_valid" CHECK (COALESCE(("todo_events"."cause" IS NULL) OR CASE
        WHEN "todo_events"."authority" IS NULL OR "todo_events"."authority" = 'user_direct' THEN "todo_events"."authority_ref" IS NULL
        WHEN jsonb_typeof("todo_events"."authority_ref") IS DISTINCT FROM 'object' THEN false
        WHEN "todo_events"."authority" = 'user_request' THEN "todo_events"."authority_ref"->>'kind' = 'message'
          AND jsonb_typeof("todo_events"."authority_ref"->'id') = 'string' AND "todo_events"."authority_ref"->>'id' <> ''
          AND "todo_events"."authority_ref" - 'kind' - 'id' = '{}'::jsonb
        WHEN "todo_events"."authority" = 'instruction' THEN "todo_events"."authority_ref"->>'kind' = 'instruction'
          AND jsonb_typeof("todo_events"."authority_ref"->'id') = 'string' AND "todo_events"."authority_ref"->>'id' <> ''
          AND "todo_events"."authority_ref" - 'kind' - 'id' - 'revision' = '{}'::jsonb
          AND CASE
            WHEN "todo_events"."authority_ref"->'revision' IS NULL THEN true
            WHEN jsonb_typeof("todo_events"."authority_ref"->'revision') <> 'number' THEN false
            ELSE ("todo_events"."authority_ref"->>'revision')::numeric >= 0
              AND ("todo_events"."authority_ref"->>'revision')::numeric = trunc(("todo_events"."authority_ref"->>'revision')::numeric)
          END
        WHEN "todo_events"."authority" = 'policy' THEN "todo_events"."authority_ref"->>'kind' = 'policy'
          AND jsonb_typeof("todo_events"."authority_ref"->'code') = 'string'
          AND "todo_events"."authority_ref"->>'code' IN ('todo.payment_match', 'todo.reply_retraction', 'triage.todo_gate')
          AND "todo_events"."authority_ref" - 'kind' - 'code' = '{}'::jsonb
        ELSE false END, false));--> statement-breakpoint
-- ADR-0115 (#1586 review). The "todo_events" checks above enforce the
-- relationships of each stored record. This function adds what the event
-- columns cannot see, because the copy reads each field as text: unknown
-- keys and the JSON type of each field. "todos"."attribution" keeps the
-- creation record until the first update, so its shape must hold there too.
CREATE OR REPLACE FUNCTION todos_check_attribution(rec jsonb) RETURNS void AS $$
DECLARE
  unknown_keys jsonb;
BEGIN
  IF rec IS NULL OR jsonb_typeof(rec) <> 'object' THEN
    RAISE EXCEPTION 'todos write has no attribution record (ADR-0115 rule 2)';
  END IF;
  unknown_keys := rec - ARRAY['actor', 'authority', 'authorityRef', 'runId', 'toolCallId', 'cause', 'note'];
  IF unknown_keys <> '{}'::jsonb THEN
    RAISE EXCEPTION 'todos attribution record has unknown keys % (ADR-0115)',
      (SELECT string_agg(k, ', ') FROM jsonb_object_keys(unknown_keys) AS k);
  END IF;
  IF jsonb_typeof(rec->'actor') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'todos write has no actor (ADR-0115 rule 2)';
  END IF;
  IF jsonb_typeof(rec->'cause') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'todos write by % has no cause (ADR-0115 rule 3)', rec->>'actor';
  END IF;
  IF COALESCE(jsonb_typeof(rec->'authority'), 'null') NOT IN ('string', 'null')
     OR COALESCE(jsonb_typeof(rec->'runId'), 'null') NOT IN ('string', 'null')
     OR COALESCE(jsonb_typeof(rec->'toolCallId'), 'null') NOT IN ('string', 'null')
     OR COALESCE(jsonb_typeof(rec->'note'), 'null') NOT IN ('string', 'null')
     OR COALESCE(jsonb_typeof(rec->'authorityRef'), 'null') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'todos attribution record has a field of the wrong JSON type (ADR-0115)';
  END IF;
  IF rec->>'actor' = 'agent' AND (COALESCE(rec->>'runId', '') = '' OR COALESCE(rec->>'toolCallId', '') = '') THEN
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
