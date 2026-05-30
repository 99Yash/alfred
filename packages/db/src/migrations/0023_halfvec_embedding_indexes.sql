-- Keep embeddings stored as vector(1024), but use halfvec HNSW expression
-- indexes for approximate candidate selection. Queries rerank those
-- candidates with the full vector distance in application SQL.
DROP INDEX IF EXISTS "chunks_embedding_hnsw_idx";--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 200);--> statement-breakpoint
DROP INDEX IF EXISTS "memory_chunks_embedding_hnsw_idx";--> statement-breakpoint
CREATE INDEX "memory_chunks_embedding_hnsw_idx" ON "memory_chunks" USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 200);
