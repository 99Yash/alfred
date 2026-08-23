# ADR-0001 — User scope: single user with multi-device sync

**Decision.** Alfred is single-user (just me) but supports multi-device sync via Replicache. Auth still gates access.

**Why.** Personal-assistant features (calendar, email, phone) are nonsensical without an implicit "me." Multi-tenant adds tables, UI, and permission machinery for a use case that doesn't exist. Adding `org_id` later is cheap; ripping it out is not. Multi-device matters because the assistant must work on phone + laptop interchangeably.

**Alternatives.** Multi-tenant SaaS (rejected — no real users, all overhead). Local-only single-machine (rejected — kills the "always with me" property of an assistant).
