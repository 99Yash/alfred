# ADR-0008 — Database: Railway-managed Postgres with pgvector

**Decision.** Single Postgres instance on Railway, pgvector extension enabled, holds domain data + Replicache state + memory + vector embeddings.

**Why.**

- Alfred's load is constant background workers + cron + vector queries — Neon's per-second-compute billing turns expensive fast in this profile (workers keep compute warm 24/7).
- Co-located with `apps/server` on Railway's private network → sub-ms query latency, zero egress.
- pgvector handles personal-scale vector search (≪ 10M chunks) trivially, with the bonus of joining to other tables (`chats ↔ chunks ↔ documents`).
- Single dashboard, single backup story, single migration tool (Drizzle Kit).

**Alternatives.**

- Neon (rejected — compute billing punishes constant background workload).
- Supabase (rejected — useful if we wanted their auth/storage, but we have Better Auth and we don't need their other primitives yet).
- TurboPuffer for vectors specifically (rejected — designed for many-tenant, billions-of-vectors economics; alfred is one tenant; transactional joins to Postgres tables are more valuable than TP's serverless cold-namespace cost advantage).
