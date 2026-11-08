# Claude Haiku 5.5 as Alfred's default model — research

Researched 2026-11-08. Primary sources: Anthropic's model docs ([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)), the [Haiku 5.5 model page](https://platform.claude.com/docs/en/models/haiku-5-5/overview), the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing), the [launch post](https://www.anthropic.com/claude-haiku-5-5) (Oct 7, 2026), the [prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5), [What's new](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5), and [rate limits](https://platform.claude.com/docs/en/api/rate-limits). Repo evidence named by file path.

## Verdict

**Do not make Claude Haiku 5.5 the default for Alfred's chat/boss workloads. Use it to replace `claude-sonnet-4-6` on the `compactor` route, and consider it for the `cheap` route.**

- Alfred's default isn't Anthropic at all: the `standard`/`boss`/`deep` routes run **OpenAI `gpt-6-luna`** (Gemini 3.8 Flash fallback), configured in `packages/ai/src/provider.ts` (`MODEL_ROUTES`). Anthropic appears only on `compactor` (`claude-sonnet-4-6`) and one media-enrichment leg.
- **Cost delta vs the current default is zero at ≤100k-token prompts** — Haiku 5.5's list price ($0.10/$0.50 per MTok, $0.01 cache read, $0.125 5m write) is identical to the gpt-6-luna prices already in Alfred's price table. Above 100k prompts Haiku jumps to $0.50/$2.50, priced *worse* than gpt-6-luna's >272k tier ($0.20/$0.75). So "Haiku as default" buys no savings on the main routes.
- **Quality**: Anthropic positions Haiku 5.5 for "classification, extraction, routing, compaction, subagent tasks", and explicitly says Sonnet 5.5 / Opus 5.5 "remain better choices for complex agentic coding" ([launch post](https://www.anthropic.com/claude-haiku-5-5)). Alfred's default chat route is exactly the workload Anthropic warns off: a multi-step grounding/tool-loop assistant (see `packages/assistant/evals/*-grounding.eval.ts`). Swapping it to Haiku risks regressions on early stopping, skipped tool calls, and system-prompt drift — all documented failure modes for this model (details below).
- The clear win is the `compactor` route: Haiku 5.5 at $0.10/$0.50 replaces Sonnet 4.6 at $3/$15 — a **30x cut on input and output** for a workload (summarization/compaction) that is Haiku 5.5's named sweet spot. Eligibility caveats in "Caveats / integration notes" must be checked first (sampling params, prefill, refusal handling).

## What "the latest Haiku" actually is

- The user's phrase "claude haiku 5.5" is correct as of Nov 2026. The latest Haiku release is **Claude Haiku 5.5, released October 7, 2026**; the prior Haiku is 4.5 (still available, legacy) ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Haiku 5.5 page](https://platform.claude.com/docs/en/models/haiku-5-5/overview)).
- Exact slugs:
  - Claude API ID: **`claude-haiku-5-5`** (Bedrock: `anthropic.claude-haiku-5-5`; Foundry/Google Cloud/AWS Claude Platform: `claude-haiku-5-5`).
  - **Selection**: per the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview), every Claude model ID "is a pinned snapshot, including the dateless IDs used from the 4.6 generation on", and for these generations the alias and the snapshot are the same string — so `claude-haiku-5-5` is both. There is no separate `latest` alias to use.
- Retirement commitment: not sooner than **October 7, 2027** on Anthropic-operated platforms ([overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)).

## Specs and pricing (Anthropic-operated Claude API)

From the [Haiku 5.5 model page](https://platform.claude.com/docs/en/models/haiku-5-5/overview) and the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing):

| Item | ≤100k prompt | >100k prompt |
| --- | --- | --- |
| Input | $0.10 / MTok | $0.50 / MTok |
| Output | $0.50 / MTok | $2.50 / MTok |
| 5m cache write | $0.125 / MTok | $0.625 / MTok |
| 1h cache write | $0.20 / MTok | $1 / MTok |
| Cache read | $0.01 / MTok | $0.05 / MTok |
| Batch API | 50% off both directions ($0.05 / $0.25 and $0.25 / $1.25) | |

- Context window **1M tokens**, max output **128K** (up to **300K** on the Batches API with the `output-300k-2026-03-24` beta header). Adaptive thinking on by default, steered by `effort` (default `medium`).
- **Prompt-length billing is per request**: a request whose prompt (including cache reads/writes) exceeds 100k pays the higher rate even if part of it was a cache hit ([long context pricing](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing)). All other current Claude models bill 1M-context at flat rates.
- **Tokenizer**: same newer tokenizer as Claude 4.7+; the same text counts as ≈30% more tokens than on Haiku 4.5 (also stated in the pricing page) — recounts affect cost estimates ([What's new](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5)).
- Comparative price points on the same docs: Sonnet 5.5 $2/$10 (cache read $0.10 after the Oct 2026 50% cut), Opus 5.5 $4/$20, Haiku 4.5 $1/$5.

## Benchmarks (Anthropic-reported; no independent leaderboards found)

All numbers are from the [launch post](https://www.anthropic.com/claude-haiku-5-5) and its [system card](https://www.anthropic.com/claude-haiku-5-5-system-card); the third-party benchmarks (GDPval, OSWorld, Terminal-Bench) are scored by Anthropic's own eval harness there. I found no Anthropic-independent scoring of Haiku 5.5 in the official pages, so treat relative positions, not exact values, as the signal.

| Benchmark | Haiku 5.5 | Haiku 4.5 | GPT-6 Luna | Sonnet 5.5 (ref) |
| --- | --- | --- | --- | --- |
| GDPval-AA v2.1 (knowledge work) | 1620 | 735 | 1437 | 1840 |
| AA-Briefcase v1.1 | 1578 | 614 | 1336 | 1824 |
| OSWorld 2.1 (computer use, offline) | 72.4% | 15.7% | 48.9% | 83.9% |
| Humanity's Last Exam (no tools) | 45.9% | 10.2% | — | 56.9% |
| Terminal-Bench 4.0 (agentic coding) | 39.2% | 0.0% | 16.4% | 70.6% |
| FrontierCode 1.1 (Main) | 46.4% | — | 42.4% | 52.1% (xhigh) |

Read: Haiku 5.5 beats GPT-6 Luna on knowledge work and computer use, roughly ties it on terminal coding, and is decisively behind Sonnet 5.5 on agentic/long-horizon work (Terminal-Bench 39.2 vs 70.6).

## Documented weaknesses and caveats (all official)

From the [prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5) and [What's new](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5):

- **Long agent prompts**: at `low` effort it "sometimes stops early and hands the task back"; moving to `medium` roughly halved early stopping but more than doubled output tokens.
- **Tool-call fidelity**: with thinking *off* plus structured JSON output (`output_config.format`), it "might skip a tool call it needs" — fixed via adaptive thinking, removing the format, `tool_choice`, or a system-prompt line.
- **Instruction following**: chatbot deployments need an added system-prompt line to resist users arguing them out of the system prompt; "when instruction following matters most, also use `high` effort".
- **Coding verification**: at `low`/`medium` it "sometimes reports a code change as done without running a check".
- **Search behavior**: can under-search (needs today's date + a nudge paragraph) or over-search under blanket instructions.
- **Positioning caveat from Anthropic itself**: "Sonnet 5.5 and Opus 5.5 remain better choices for complex agentic coding tasks... Haiku 5.5 is best suited to more narrowly scoped tasks... like compaction, summarization, or subagent work" ([launch post](https://www.anthropic.com/claude-haiku-5-5)).
- **Breaking changes vs Haiku 4.5** ([What's new](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5)): sampling params (`temperature`/`top_p`/`top_k`) error; assistant prefill errors; manual `budget_tokens` thinking errors; earlier-turn edits invalidate thinking blocks; thinking blocks from earlier turns stay in context (more input tokens); new `stop_reason: "refusal"` from safety classifiers with **no server-side fallback**.

## Rate limits / availability

From the [rate-limits page](https://platform.claude.com/docs/en/api/rate-limits): Haiku 5.5 shares the top bucket — Start tier **4,000 RPM / 2M ITPM / 400k OTPM** (double Haiku 4.5's 1,000 RPM), Build 10,000 / 5M / 1M, Scale 13,000 / 10M / 2M. Monthly spend caps: Start $500, Build $1,000, Scale $200,000. **ITPM counts only uncached input**, so caching raises effective throughput. Available now on all platforms including Bedrock, Google Cloud, and Azure ([launch post](https://www.anthropic.com/claude-haiku-5-5)). Note Alfred reaches Anthropic through a Cloudflare AI Gateway (`packages/ai/src/gateway.ts`) — availability/slugs there need a probe before any switch.

## What Alfred currently uses

- **Route table**: `packages/ai/src/provider.ts` (`MODEL_ROUTES`), reached via `route(name)` (`@alfred/ai`). There is no single env "default model"; the product default chat route is **`standard`**.
  - `standard` (chat/reply drafting) and `boss` (briefings, triage deepen, cold start, skill compose), `subAgent`, `deep`: **OpenAI `gpt-6-luna`** primary *(Alfred's default)*, **Google `gemini-3.8-flash`** fallback, reasoning `medium` (`xhigh` on `deep`).
  - `cheap`: `gemini-2.5-flash-lite` → `gemini-3.8-flash`, reasoning `none`.
  - `compactor`: **Anthropic `claude-sonnet-4-6`**, reasoning `none`; `compactorFallback`: `gemini-3.8-flash`.
  - Media enrichment: Gemini legs, then `claude-sonnet-4-6` for text/image/pdf.
- **Consumers of the default**: `packages/assistant/src/reply-drafting/compose.ts` (`route("standard")`), `packages/assistant/src/briefings/compose.ts` and `triage/deepen.ts` / `skills/compose.ts` / knowledge cold-start (`route("boss")`); eval suites default to `route("standard")` (`packages/assistant/evals/README.md`).
- **Anthropic model plumbing**: `packages/ai/src/provider-adapter.ts` — `anthropicLeg()` takes `KnownModelId<Parameters<AnthropicProvider>[0]>` (admitted IDs come from `@ai-sdk/anthropic`, not a hardcoded list), wrapped with tool-name codec and provider middleware; Anthropic is created via the Cloudflare gateway in `packages/ai/src/gateway.ts`. Provider effort mapping and cache-control also live there.
- **Current default's price tier**: per Alfred's own static price table (`packages/db/src/scripts/sync-prices.ts`, entry sourced from OpenAI's model page, 2026-09-24): `gpt-6-luna` = **$0.10 input / $0.50 output / MTok, $0.01 cached input, $0.125 cache write, 1.05M context; >272k-prompt tier $0.20/$0.75**. That is small-model (Haiku-class) pricing, not Sonnet/Opus tier — the repo's "expensive" model today is instead `claude-sonnet-4-6` on `compactor` ($3/$15 per Anthropic's pricing page).

## Fit assessment for Alfred's default workloads

Alfred's default-route work is chat with tools plus background drafting/triage/briefing (per route comments and `docs/reference/ai-sdk.md` conventions: grounded tool loops, effort `medium`, metered wrappers):

1. **Quality**: Alfred's standard route leans on reasoning-brushed tool loops with grounding evals (date/calendar/github/sender-suppression grounding, tool-selection bloat — `packages/assistant/evals/`). Haiku 5.5's documented failure modes (early stopping in long agent prompts, skipped tool calls alongside structured output, system-prompt drift under user pushback, unverified completion reports at `low`/`medium` effort) sit exactly on these axes. Its Terminal-Bench and FrontierCode numbers trail Sonnet 5.5 badly on long-horizon agentic tasks.
2. **Cost**: not a lever — Haiku 5.5 and the current default price identically up to 100k prompts, and Haiku is *more* expensive above it ($0.50/$2.50 vs $0.20/$0.75). Alfred's long-context routes would pay more.
3. **Diversification**: Anthropic is currently a single-purpose leg; making it the default would also concentrate billing on one vendor while OpenAI/Gemini fallbacks remain.
4. **Where it does fit**:
   - `compactor` → `claude-haiku-5-5`: 30x cheaper than Sonnet 4.6 ($3/$15 → $0.10/$0.50; cache read $0.30 → $0.01/0.05), faster, and compaction/summarization is Anthropic's named use case. Verify the repo sends no sampling params and no prefill, handles `stop_reason: "refusal"`, and add the model to the price table (`sync-prices.ts` + context-window map `packages/ai/src/metering/prices.ts`, which currently admits only `anthropic/claude-sonnet-4-6`).
   - `cheap` (currently `gemini-2.5-flash-lite`) and extraction/routing subagents: plausible Haiku 5.5 candidates at `low`–`medium` effort; run against Alfred's evals before switching.

**Bottom line**: adopt `claude-haiku-5-5` where the work is classification, extraction, compaction, and cheap subagents — especially as the compactor model — but keep `gpt-6-luna` (or Sonnet 5.5 if quality justifies it) as the default assistant model.
