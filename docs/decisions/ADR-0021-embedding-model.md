# ADR-0021 — Embedding model


**Decision.** Voyage family as primary, Gemini text-embedding-005 as fallback (credential-gated).

- **Ingestion**: voyage-context-3 at 1024 dim — contextualized embeddings handle long-form emails/docs where chunk-in-isolation loses meaning.
- **Query-side**: voyage-3.5 at 1024 dim — cheaper, faster, plenty for short query strings.
- **Fallback**: gemini-embedding-001 / text-embedding-005 (768 dim, with separate index column if it ships) when Voyage credentials missing.
- **Index**: pgvector HNSW, cosine distance, `m=16, ef_construction=200, ef_search=80`. Tunable post-launch.
- **Reranker**: Voyage rerank-2.5-lite for hybrid search final stage (BM25 + vector + RRF + rerank, mirroring dimension's pattern).

**Why Voyage at 1024 dim:**

- Top-tier English retrieval quality on MTEB (per recent benchmarks); voyage-context-3 specifically wins on long-doc retrieval.
- Anthropic recommends Voyage as embedding partner — vendor-aligned with our LLM choice.
- 1024 dim is the model's native output; matches HNSW well; smaller index than 1536 with negligible recall loss at our scale.
- Pricing: ingestion at ~$3-9 lifetime cost for a 50M-token personal corpus.

**Why model name is pinned at implementation time, not in this ADR:** Voyage's lineup evolves (Ronit references "Voyage-4" which doesn't match the current public catalog as of writing); models.dev is the source of truth for current version + pricing. The decision is "Voyage family at 1024 dim with Gemini fallback," not a specific SKU.

**Single embedder module.** `packages/ai/embeddings.ts` hides model name + provider behind `embed(text, opts)`. Swapping families later is one-file change.

**Rotation plan** (future-proofing):

- Schema: `embedding_v2` column rather than altering `embedding`; backfill via BullMQ chunked job; flip read path; drop old.
- Don't write code that hardcodes "voyage" anywhere outside the embedder module.

**Alternatives.**

- OpenAI text-embedding-3-large at 3072 dim (rejected — credentials-gated; 3x index size for marginal recall gain).
- Cohere embed-v4 (rejected — thinner ecosystem, no clear win over Voyage at our scale).
- Local BGE / nomic-embed (rejected — Railway compute cost > Voyage spend; only justified if privacy-vs-Voyage matters and we already trust Anthropic with full-text content).
