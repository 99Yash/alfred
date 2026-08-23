# ADR-0022 — Web search provider: Perplexity (Sonar Pro + Sonar Deep Research)

**Decision.** Perplexity for both web-search use cases. Two SKUs split by use case:

- **Cold-start research at signup** (ADR-0011) → **Sonar Deep Research**. Multi-step, multi-source synthesis with structured citations. Async via BullMQ; latency (30-90s) tolerable. ~$1-5/signup.
- **Live agent web-search tool** → **Sonar Pro**. Synthesized answers + citations in 2-5s. Available to boss/sub-agents/skills as a regular tool. Few-cents-per-day at personal scale.

Both flow through `metered()` (`kind=web_search`).

**Why Perplexity over Tavily/Exa/Brave/SerpAPI:**

- **Synthesis-shaped output** matches how agents actually consume search — answers + citations, not raw URL lists. Saves the fetch-extract-summarize pipeline.
- **Disambiguation reasoning** is materially better on hard queries (low-public-footprint name disambiguation, conflicting-context queries). Tavily test query for the user's name returned mostly noise (Bollywood actor confusion, unrelated PDFs); the failure mode is structural, not accidental.
- **Sonar Deep Research is the natural cold-start tool** — multi-step research-and-synthesize in one call, with citation discipline. Approximates what a human researcher would do over an hour.
- **Credentials already available**, removing one decision.

**Latency caveat.** Perplexity Sonar models add LLM-pass latency (2-5s for Sonar Pro, 30-90s for Deep Research) versus raw search APIs (sub-second). Agent prompts must reflect this — web search is _deliberate_, not _exploratory_. Cold-start research runs in BullMQ so users never see the latency.

**Alternatives.**

- Tavily (rejected after test — disambiguation poor on low-public-footprint names; requires extra synthesis layer for agent consumption).
- Exa (rejected — strong on "find similar pages" semantic search but weaker for entity research; could layer in later for that specific use case).
- Brave / SerpAPI (rejected — raw results force us to build extraction/scoring/dedup ourselves; Perplexity already does it).

**Amendment (2026-06-12) — live tool moved to grounded Gemini.** The Perplexity account lost billing (`401 insufficient_quota`), so the **live agent web-search tool** was re-pointed from Sonar Pro to **grounded Gemini 2.5 Flash** (`getWebSearchModel()` + `googleSearchGroundingTools()`, Google Search grounding via `@ai-sdk/google` — the `google_search` provider tool runs server-side inside one generation). Same `system.web_search` dispatched function tool, same `metered(kind=web_search)` path; citations now read from `providerMetadata.google.groundingMetadata.groundingChunks[].web.uri`. Rationale beyond cost: the Gemini key was already held, latency is comparable (~5s), and it avoids a second vendor dependency. Caveats live with this choice: (1) web search is now **provider-locked to Gemini** — the `getWebSearchModel()` abstraction is the seam if we want a Gemini↔X fallback later; (2) grounding adds a per-request Google fee on top of tokens that `model_prices` doesn't yet capture (trivial at single-user scale); (3) Gemini grounding quality vs. Sonar Pro is unvalidated — a candidate for an evalite bake-off (ADR-0055). **Cold-start / dossier Deep Research (`getResearchModel()`) is still Perplexity and therefore stranded** until billing is restored or it too migrates to a grounded-Gemini research loop (the "powerful research sub-agent" / option C direction).
