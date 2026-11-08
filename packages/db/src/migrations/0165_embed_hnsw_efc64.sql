-- Rebuild `chunks_embedding_hnsw_idx` with `ef_construction = 64` (was 200).
--
-- A prod A/B (2026-11-08) on 42k chunks: per-embedded-row insert time went
-- from ~43 ms to ~8.8 ms (the HNSW entry is the entire per-row insert floor),
-- and top-10 recall was identical on 40 random probe queries (100% overlap).
-- The graph is also 48 MB smaller (86 MB vs 134 MB).
--
-- The HNSW index lives only in migration SQL (no drizzle schema entry), per
-- the `chunks` table comment. Guarded so replaying on a DB that already holds
-- the new graph (prod, swapped ahead of this migration) is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE indexname = 'chunks_embedding_hnsw_idx'
       AND indexdef ~ 'ef_construction *= *''?64''?'
  ) THEN
    DROP INDEX IF EXISTS "chunks_embedding_hnsw_idx";
    CREATE INDEX "chunks_embedding_hnsw_idx"
      ON "chunks"
      USING hnsw (((embedding)::halfvec(1024)) halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END
$$;
