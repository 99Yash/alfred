ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_source_shape" CHECK (jsonb_typeof("memory_chunks"."source") = 'object'
    AND "memory_chunks"."source" ? 'kind'
    AND "memory_chunks"."source"->>'kind' IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
    AND ("memory_chunks"."source"->'id' IS NULL OR jsonb_typeof("memory_chunks"."source"->'id') = 'string')
    AND ("memory_chunks"."source"->'meta' IS NULL OR jsonb_typeof("memory_chunks"."source"->'meta') = 'object'));--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_source_shape" CHECK (jsonb_typeof("user_facts"."source") = 'object'
    AND "user_facts"."source" ? 'kind'
    AND "user_facts"."source"->>'kind' IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
    AND ("user_facts"."source"->'id' IS NULL OR jsonb_typeof("user_facts"."source"->'id') = 'string')
    AND ("user_facts"."source"->'meta' IS NULL OR jsonb_typeof("user_facts"."source"->'meta') = 'object'));--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_source_shape" CHECK (jsonb_typeof("user_preferences"."source") = 'object'
    AND "user_preferences"."source" ? 'kind'
    AND "user_preferences"."source"->>'kind' IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
    AND ("user_preferences"."source"->'id' IS NULL OR jsonb_typeof("user_preferences"."source"->'id') = 'string')
    AND ("user_preferences"."source"->'meta' IS NULL OR jsonb_typeof("user_preferences"."source"->'meta') = 'object'));