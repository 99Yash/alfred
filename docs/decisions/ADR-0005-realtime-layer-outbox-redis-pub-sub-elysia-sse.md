# ADR-0005 — Realtime layer: outbox + Redis Pub/Sub + Elysia SSE


**Decision.** Mutators write domain rows + an `events_outbox` row in one transaction. A relay worker (woken via Postgres LISTEN/NOTIFY internally) reads new outbox events and publishes to Redis Pub/Sub channels keyed `user:{id}`. Elysia exposes per-user SSE endpoints that subscribe to the relevant channel and push events to the client. Replicache pokes are one event type; agent progress, tool-call updates, and approval requests are others.

**Why.**

- **Outbox** gives transactional consistency: domain writes and event fan-out can't drift.
- **Redis Pub/Sub** is broadcast (every server instance sees every event → fans to its own SSE clients), which matches multi-instance fan-out semantics. Streams would duplicate the durability layer without buying delivery guarantees that browsers can't enforce anyway.
- **SSE** is dead-simple, integrates with AI SDK's existing streaming, and works behind any HTTP proxy.
- **Redis is in-stack already** (BullMQ), so Pub/Sub costs zero new dependencies.
- **PG LISTEN/NOTIFY** stays in its blessed niche: internal trigger that wakes the relay. Not used for client delivery.

**Alternatives.**

- Ably (rejected — external paid vendor for a fan-out problem we don't have at our scale; mirroring dimension on this layer is cosmetic).
- Bare LISTEN/NOTIFY → SSE (rejected — breaks at multi-instance, weaker resume narrative).
- Redis Streams (rejected — duplicates outbox durability, awkward broadcast semantics).
- Self-hosted WebSocket (rejected — bidirectional capability not needed; Eden RPC handles client→server).

**Caveat.** End-to-end "delivery guarantees" to a browser are impossible (no app-level ack); reconnect logic must always assume some events were missed and resync via Replicache pull or a `since_ts` outbox replay endpoint.
