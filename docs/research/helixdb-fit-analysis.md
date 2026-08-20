---
date: 2026-08-20
project: alfred
context: graph database evaluation — HelixDB self-hosted fit
---

# HelixDB Self-Hosted Fit Analysis

## Context

Alfred rejected Neo4j and Zep for cost reasons. Entities and relations live in PostgreSQL
with a naive adjacency-list pattern (`entities` + `entity_relations` tables) plus a newer
observation-backed substrate (`entity_nodes` + `entity_edges` with versioned projections).
Embeddings use pgvector with HNSW indexes (1024-dim halfvec). Scale assumption: <10K
entities per user.

The question: can HelixDB self-host on Railway, and is it a compatible fit?

---

## What HelixDB Is

- OLTP graph-vector database built in Rust. Apache 2.0 license.
- Unifies graph traversal, vector search, KV, document, and relational models.
- Backed by Y Combinator and Nvidia. ~5.8K GitHub stars. Active development (v3.0.5, June 2026).
- TypeScript, Rust, Python, Go SDKs. Queries sent as JSON AST to `POST /v2/query`.

## Self-Hosting Reality

**The engine is not open-sourced.** The GitHub repo contains CLI tooling and SDKs only.
The database server runs exclusively as a Docker container image
(`ghcr.io/helixdb/helixdb`).

| Mode | Persistence | Deployment |
|------|-------------|------------|
| In-memory | Lost on stop | `helix start dev` (Docker) |
| Disk (`--disk`) | MinIO volume (2nd container) | Docker Compose |
| S3-compatible | External store | `--storage-uri s3://...` |

Local development is smooth. Production self-hosting requires:
- Docker infrastructure management
- MinIO or S3 for persistence
- Image pull upgrades
- Own monitoring, alerting, backup strategy

## Railway Blocker: No Docker-in-Docker

Railway does **not** support Docker-in-Docker. Confirmed in Railway feedback forum
(2024-04, still current):

> "You simply can't do such things on Railway." — Railway staff

HelixDB self-hosted = Docker container. Railway services = Docker containers.
Running a container inside a container requires privileged mode, which Railway
denies. **HelixDB cannot self-host on Railway.**

## HelixDB Cloud Pricing

From HN discussion (2026): HelixDB Cloud starts at ~$600/mo. No published
self-serve pricing tiers. Enterprise sales via "Book a call."

## Cost Comparison (Railway)

| Option | Monthly Cost |
|--------|-------------|
| Alfred PG (current) | ~$22 (0.5 vCPU, 1GB, 5GB volume on Hobby) |
| HelixDB Cloud | ~$600+ |
| HelixDB self-hosted (hypothetical VPS) | $20-40 + ops burden |

## Data Model Compatibility

### What Alfred has now

1. **Legacy graph**: `entities` (nodes) + `entity_relations` (edges) — adjacency list
2. **Observation substrate**: `entity_nodes` + `entity_edges` + `entity_profiles` +
   `entity_co_occurrence` — versioned projections, supersession chains, content-addressed IDs
3. **Vector search**: pgvector HNSW on `memory_chunks.embedding` and `chunks.embedding`
4. **Relational data**: Users, documents, integrations, extraction status — standard PG tables

### What HelixDB provides

- Graph + vector as first-class primitives
- Single query can traverse edges AND do vector similarity
- No versioned projections, no supersession chains, no observation logs
- No SQL compatibility — new query DSL (HQL)
- No pgvector ecosystem (Drizzle, migrations, existing indexes)

### Migration cost

- Rewrite all Drizzle schema → HelixDB DSL
- Rewrite `entity-graph.ts` traversal queries
- Rewrite `team-graph.ts` population logic
- Rewrite `sender-relationship.ts` resolver
- Rewrite `significance.ts` computation
- Lose the observation-backed substrate (ADR-0067) entirely
- Lose SQL access for ad-hoc queries and debugging
- Lose pgvector integration with existing embed pipeline
- Dual-write or cutover strategy needed

## Verdict

**HelixDB is not a fit for Alfred.** Three independent blockers:

1. **Cannot self-host on Railway** — Docker-in-Docker not supported. Non-starter.
2. **Cloud pricing (~$600/mo)** — 27x the current PG cost. Rejected for same reason as Neo4j/Zep.
3. **Data model mismatch** — Alfred's observation-backed substrate with versioned
   projections, supersession chains, and content-addressed IDs has no HelixDB equivalent.
   Migration would mean losing architectural investments (ADR-0067) for a simpler model.

The naive adjacency-list graph in PG is actually well-suited to Alfred's scale (<10K
entities per user). The one-hop traversal via two joins is fast at this scale. If
multi-hop traversal becomes needed, recursive CTEs in PG are the natural next step —
no new database required.

## Sources

- HelixDB docs: https://docs.helix-db.com/database/local-development
- HelixDB GitHub: https://github.com/HelixDB/helix-db (5.8K stars, Apache 2.0)
- OpenApps review: https://openapps.pro/apps/helix-db
- HN discussion: https://news.ycombinator.com/item?id=48478148
- Railway pricing: https://docs.railway.com/pricing/plans
- Railway DinD forum: https://station.railway.com/feedback/docker-in-docker-d07c4730
- Alfred schema: `packages/db/src/schema/memory.ts`, `packages/db/src/schema/user-model.ts`
- Alfred graph code: `packages/assistant/src/knowledge/entity-graph.ts`
