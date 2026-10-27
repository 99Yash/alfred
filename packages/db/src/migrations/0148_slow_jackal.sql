ALTER TABLE "chunks" ADD CONSTRAINT "chunks_metadata_page_valid" CHECK (jsonb_typeof("chunks"."metadata") = 'object'
        AND (NOT ("chunks"."metadata" ? 'page')
          OR (jsonb_typeof("chunks"."metadata"->'page') = 'number'
            AND ("chunks"."metadata"->>'page')::numeric >= 1
            AND ("chunks"."metadata"->>'page')::numeric = trunc(("chunks"."metadata"->>'page')::numeric))));