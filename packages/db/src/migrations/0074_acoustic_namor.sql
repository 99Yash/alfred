UPDATE "memory_chunks"
SET "source" = jsonb_build_object(
  'kind', 'agent',
  'meta', jsonb_build_object('migratedInvalidSource', true, 'previousSource', "source")
)
WHERE "source" = '{}'::jsonb;--> statement-breakpoint
UPDATE "memory_chunks"
SET "source" = jsonb_build_object(
  'kind', 'agent',
  'meta', jsonb_build_object('migratedInvalidSource', true, 'previousSource', "source")
)
WHERE jsonb_typeof("source") <> 'object'
  OR "source" ->> 'kind' IS NULL
  OR "source" ->> 'kind' NOT IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
  OR ("source" -> 'id' IS NOT NULL AND jsonb_typeof("source" -> 'id') <> 'string')
  OR ("source" -> 'meta' IS NOT NULL AND jsonb_typeof("source" -> 'meta') <> 'object');--> statement-breakpoint
UPDATE "user_facts"
SET "source" = jsonb_build_object(
  'kind', 'document',
  'meta', jsonb_build_object('migratedInvalidSource', true, 'previousSource', "source")
)
WHERE "source" = '{}'::jsonb;--> statement-breakpoint
UPDATE "user_facts"
SET "source" = jsonb_build_object(
  'kind', 'document',
  'meta', jsonb_build_object('migratedInvalidSource', true, 'previousSource', "source")
)
WHERE jsonb_typeof("source") <> 'object'
  OR "source" ->> 'kind' IS NULL
  OR "source" ->> 'kind' NOT IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
  OR ("source" -> 'id' IS NOT NULL AND jsonb_typeof("source" -> 'id') <> 'string')
  OR ("source" -> 'meta' IS NOT NULL AND jsonb_typeof("source" -> 'meta') <> 'object');--> statement-breakpoint
UPDATE "user_preferences"
SET "source" = jsonb_build_object(
  'kind', 'user',
  'meta', jsonb_build_object('migratedInvalidSource', true, 'previousSource', "source")
)
WHERE "source" = '{}'::jsonb;--> statement-breakpoint
UPDATE "user_preferences"
SET "source" = jsonb_build_object(
  'kind', 'user',
  'meta', jsonb_build_object('migratedInvalidSource', true, 'previousSource', "source")
)
WHERE jsonb_typeof("source") <> 'object'
  OR "source" ->> 'kind' IS NULL
  OR "source" ->> 'kind' NOT IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
  OR ("source" -> 'id' IS NOT NULL AND jsonb_typeof("source" -> 'id') <> 'string')
  OR ("source" -> 'meta' IS NOT NULL AND jsonb_typeof("source" -> 'meta') <> 'object');--> statement-breakpoint
ALTER TABLE "memory_chunks" ALTER COLUMN "source" SET DEFAULT '{"kind":"agent"}'::jsonb;--> statement-breakpoint
ALTER TABLE "user_facts" ALTER COLUMN "source" SET DEFAULT '{"kind":"agent"}'::jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "source" SET DEFAULT '{"kind":"user"}'::jsonb;
