# ADR-0006 — Agent runtime: roll-your-own durable execution


**Decision.** Build a small durable agent runtime in TypeScript: state table in Drizzle, step function (`runStep(state) → nextState | interrupt | done`), worker loop driven by BullMQ, `interrupt()` primitive for HIL pauses. AI SDK is called inside steps; tool definitions are AI-SDK-native.

**Why.**

- LangGraph TS is a port that lags Python; bug-fix and ecosystem latency. Dimension uses Python LangGraph — mirroring it on the TS side gets you the _name_ not the substance.
- Polyglot (TS + Python LangGraph service) is a tax for one developer: two languages, two deploys, RPC boundary.
- Mastra is fine but opinionated; rolling the runtime ourselves is ~500 LOC for the patterns we actually need (checkpoints, interrupts, idempotent steps), and keeps the entire stack typed end-to-end via AI SDK + Eden + Drizzle.
- The architectural pattern (durable execution with checkpoint-based HIL interrupts) is the resume signal, not the package name.

**Alternatives.**

- LangGraph TS + AI SDK in nodes (rejected — fights message-format mismatch and TS-port maturity).
- Mastra (rejected — opinionated, less stack-coherent than rolling our own).
- Inngest / Trigger.dev / Hatchet (rejected — managed vendor coupling, less control over agent graph).
- Polyglot Python LangGraph (rejected — two-runtime tax for one developer).
