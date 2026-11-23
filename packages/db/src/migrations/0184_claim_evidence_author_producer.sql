-- ADR-0123 (docs/theory/memory.md §3, §10 step 1): a claim row cites its evidence, its author,
-- and its producer. The backfill reads the old "source" column, which migration 0185 drops.
-- A row with no evidence that a check can read again is retired (owner decision 2026-11-23).
ALTER TABLE "user_facts" ALTER COLUMN "valid_from" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_facts" ALTER COLUMN "valid_from" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_facts" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "user_facts" ADD COLUMN "producer" jsonb;--> statement-breakpoint
-- Author: the user's own words (a memory-page write, a chat instruction) or the agent's conclusion.
UPDATE "user_facts" SET
  "author" = CASE
    WHEN "source"->>'kind' = 'user' THEN 'user'
    WHEN "source"->>'kind' = 'tool_call' AND "key" = 'standing_instruction' THEN 'user'
    ELSE 'agent'
  END,
  "producer" = jsonb_build_object(
    'pipeline', CASE "source"->>'kind'
      WHEN 'document' THEN 'memory-extraction'
      WHEN 'cold_start' THEN 'cold-start'
      WHEN 'tool_call' THEN CASE WHEN "key" = 'standing_instruction' THEN 'system.remember' ELSE 'tool_call' END
      WHEN 'user' THEN CASE WHEN "key" = 'standing_instruction' AND "source"->>'id' IS NULL THEN 'instruction-backfill' ELSE 'memory-page' END
      ELSE "source"->>'kind'
    END,
    'runId', CASE
      WHEN "source"->>'kind' = 'cold_start' THEN "source"->>'id'
      ELSE "source"->'meta'->>'runId'
    END,
    'commit', NULL,
    'model', NULL
  ),
  "evidence" = '[]'::jsonb;--> statement-breakpoint
-- A mail or activity document that still exists.
UPDATE "user_facts" f SET "evidence" = jsonb_build_array(jsonb_build_object('kind', 'document', 'id', d."id"))
FROM "documents" d
WHERE f."source"->>'kind' = 'document' AND d."id" = f."source"->>'id' AND d."user_id" = f."user_id";--> statement-breakpoint
-- A chat instruction: the user turn that started the run. User turns before 2026-11 carry no run id,
-- so the turn is the newest user message at or before the run start, at most 5 minutes before it.
UPDATE "user_facts" f SET "evidence" = jsonb_build_array(jsonb_build_object('kind', 'chat_message', 'id', m."id"))
FROM "agent_runs" r
JOIN LATERAL (
  SELECT cm."id" FROM "chat_messages" cm
  WHERE cm."user_id" = r."user_id"
    AND cm."role" = 'user'
    AND cm."created_at" <= r."created_at" + interval '1 second'
    AND cm."created_at" >= r."created_at" - interval '5 minutes'
  ORDER BY cm."created_at" DESC
  LIMIT 1
) m ON true
WHERE f."source"->>'kind' = 'tool_call'
  AND f."key" = 'standing_instruction'
  AND r."id" = f."source"->'meta'->>'runId'
  AND r."user_id" = f."user_id";--> statement-breakpoint
-- A backfilled copy of a chat instruction (no source id): the evidence of a row with the same words.
UPDATE "user_facts" f SET "evidence" = coalesce((
  SELECT o."evidence" FROM "user_facts" o
  WHERE o."user_id" = f."user_id"
    AND o."key" = 'standing_instruction'
    AND o."id" <> f."id"
    AND jsonb_array_length(o."evidence") > 0
    AND lower(regexp_replace(coalesce(o."value"->>'phrasing', o."value"->>'directive', ''), '\s+', ' ', 'g'))
      = lower(regexp_replace(coalesce(f."value"->>'phrasing', f."value"->>'directive', ''), '\s+', ' ', 'g'))
  ORDER BY o."created_at"
  LIMIT 1
), f."evidence")
WHERE f."source"->>'kind' = 'user'
  AND f."key" = 'standing_instruction'
  AND f."source"->>'id' IS NULL
  AND jsonb_array_length(f."evidence") = 0;--> statement-breakpoint
-- A memory-page write: the user's own act at the write time.
UPDATE "user_facts" SET "evidence" = jsonb_build_array(jsonb_build_object(
  'kind', 'user_edit', 'surface', 'memory_page', 'action', 'create',
  'at', to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
WHERE "source"->>'kind' = 'user'
  AND "key" <> 'standing_instruction'
  AND jsonb_array_length("evidence") = 0;--> statement-breakpoint
-- The start of validity: the time the user said it, else unknown. The write time is not the start.
UPDATE "user_facts" f SET "valid_from" = (
  SELECT cm."created_at" FROM "chat_messages" cm WHERE cm."id" = f."evidence"->0->>'id'
)
WHERE f."evidence"->0->>'kind' = 'chat_message';--> statement-breakpoint
UPDATE "user_facts" SET "valid_from" = NULL
WHERE NOT ("evidence"->0->>'kind' = 'chat_message') OR jsonb_array_length("evidence") = 0;--> statement-breakpoint
-- No evidence found: retire the row. Its value stays in the history.
UPDATE "user_facts" SET
  "status" = 'retired',
  "valid_until" = coalesce("valid_until", now()),
  "row_version" = "row_version" + 1
WHERE jsonb_array_length("evidence") = 0;--> statement-breakpoint
-- The 0.85 auto-confirm is gone: an agent claim is confirmed only by the user (memory.md §9 Q6).
UPDATE "user_facts" SET
  "status" = 'proposed',
  "row_version" = "row_version" + 1
WHERE "author" = 'agent' AND "status" = 'confirmed';--> statement-breakpoint
ALTER TABLE "user_facts" ALTER COLUMN "author" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_facts" ALTER COLUMN "evidence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_facts" ALTER COLUMN "producer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_author_valid" CHECK ("user_facts"."author" IN ('agent', 'user'));--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_evidence_shape" CHECK (jsonb_typeof("user_facts"."evidence") = 'array' AND ("user_facts"."status" = 'retired' OR jsonb_array_length("user_facts"."evidence") > 0));--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_confirmed_by_user" CHECK ("user_facts"."status" <> 'confirmed' OR "user_facts"."author" = 'user' OR "user_facts"."evidence" @> '[{"kind":"user_edit","action":"confirm"}]'::jsonb);--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_producer_shape" CHECK (jsonb_typeof("user_facts"."producer") = 'object' AND "user_facts"."producer" ? 'pipeline');
