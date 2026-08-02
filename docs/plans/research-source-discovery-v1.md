# Research source discovery (v1)

> **Status:** design proposal. Nothing is built yet.
>
> **Basis:** the repository state on 2026-08-02. It grounds on the live boss
> research path (`system.spawn_sub_agent`, `system.web_search`,
> `system.fetch_url`) and on the `fetch_url` Firecrawl fallback (#509/#510).

## Outcome

Alfred must find the source that a request depends on, not stop at one ranked
search. When a user names a brand, a product, or a docs site, Alfred must probe
the conventional machine-readable paths that the site publishes.

The driving case: a user says "write my resume with Vercel's design system." The
canonical source is `https://vercel.com/design.md`. A ranked search does not
return it, because it is a manifest, not a human page. Alfred must reach it.

Both facts below are verified live on 2026-08-02:

- `https://vercel.com/design.md` is a real design document. It opens: "Act as an
  excellent Vercel designer, editor, information architect, data storyteller,
  and design engineer."
- `https://vercel.com/llms.txt` exists. It points to
  `https://vercel.com/docs/llms-full.txt`, a full index of the docs.

## The gap today

The boss delegates open research to a sub-agent through `system.spawn_sub_agent`
(ADR-0073 join). That sub-agent holds two read tools: `system.web_search` and
`system.fetch_url`. The loop is bounded by a step budget
(`stopWhen: isStepCount(n)`).

Two failures follow:

1. `web_search` ranks human pages. A manifest path is never a ranked result, so
   the agent never sees `vercel.com/design.md`.
2. The loop stops after one search. The step budget is a limit, not a test of
   completeness. This is the charter's known one-search-and-stop failure.

## What ships

One read-only tool: `research.discover`. It probes a small fixed set of
machine-readable paths for a named subject, then returns the sources it found.
It calls `runFetchUrl` for every probe, so it inherits every `fetch_url` guard.

The research sub-agent calls `research.discover` first. It uses `web_search`
only when discovery finds no owner source.

### Tool shape

Register it with `liveTool`, the same pattern as `system.spawn_sub_agent`:

```ts
liveTool({
  integration: "research",
  action: "discover",
  riskTier: "no_risk", // read-only; no approval gate
  description:
    "Find a named source's own machine-readable docs. Probe /llms.txt, " +
    "/llms-full.txt, a page's .md variant, /sitemap.xml, and /design.md " +
    "before you trust ranked web_search. Returns the sources found and every " +
    "path tried.",
  // No `surface: "kernel"` — the tool is lazy. The catalog surfaces it.
  availability: { callers: ["boss", "sub_agent"] },
  discovery: {
    aliases: ["find design system", "official docs", "llms.txt", "brand guide"],
    tags: ["research", "web", "docs"],
    entities: ["docs", "design system", "brand", "manifest"],
    verbs: ["find", "discover", "locate", "read"],
  },
  inputSchema: researchDiscoverInputSchema,
  execute: async (input, ctx) => runResearchDiscover(input, ctx),
});
```

The `discovery` block is the router. `preloadToolsForPrompt` ranks it against the
user's turn, and `system.search_tools` finds it by name mid-run. The tool never
sits in the system prompt; the catalog surfaces it on demand.

### Input

```ts
researchDiscoverInputSchema = z.object({
  // The named source, e.g. "Vercel's design system".
  subject: z.string().min(1),
  // A known home URL to probe first. Optional; the tool resolves one if absent.
  homeUrl: z.string().url().optional(),
  // What the caller needs from the source. Sharpens the coverage test.
  intent: z.string().optional(),
});
```

### Output

```ts
interface DiscoveredSource {
  url: string;
  kind: "llms_index" | "markdown_page" | "sitemap" | "search_hit";
  title?: string;
  fetchedChars?: number;
  confidence: number; // 0..1
}

interface ProbeAttempt {
  url: string;
  // The fetch_url outcome. "ok" or a FetchUrlError["reason"] such as
  // "empty_content", "http_error", "too_large".
  outcome: string;
}

interface ResearchDiscoverResult {
  ok: boolean;
  sources: DiscoveredSource[];
  probed: ProbeAttempt[]; // every path tried, for honesty and audit
  notes?: string;
}
```

`probed` is not decoration. It records every path and its outcome. It proves the
tool tried the fixed paths, and it lets a scorer check the trajectory.

## The probe strategy

The order is deterministic. It is code, not a model guess.

1. **Resolve the home domain.** Use `homeUrl` when the caller gives one.
   Otherwise run one `web_search` for the subject. Take the top publisher domain
   from `WebSearchResult.results`.
2. **Probe the fixed paths through `runFetchUrl`,** in this order:
   - `/llms.txt`, `/llms-full.txt`, `/docs/llms.txt`, `/docs/llms-full.txt`
   - `/design`, `/design.md`
   - the `.md` variant of any docs URL the caller already holds (append `.md`)
   - `/sitemap.xml`, then `/robots.txt` for its `Sitemap:` line
3. **Parse an `llms.txt` hit.** Its links are candidate primary sources. Add
   them to `sources` with `kind: "llms_index"`.
4. **Fall back to ranked search.** When every probe returns `empty_content` or
   `http_error`, run `web_search` and return its `results` as
   `kind: "search_hit"`. The `fetch_url` Firecrawl fallback already ran on each
   empty probe, so a JS-only page had its chance first.

## The stop condition

Stop on coverage, not on a step count.

- Stop when the tool holds at least one owner source that matches the `intent`.
- Otherwise stop when it spends the probe budget. Start the budget at 8 fetches.
- The order follows the `source ladder`: memory, then accounts, then web, then
  the owner's own manifest.

## The coverage rubric

The research sub-agent brief states what "done" means. State principles, not a
site list.

- You found the owner's primary source, not a third-party write-up.
- You tried the fixed machine-readable paths before you trusted ranked search.
- You followed each claim to the source that owns it.
- Vercel is one boundary example. Do not hard-code a site list.

## Reuse and the trust boundary

- `research.discover` calls `runFetchUrl` for every probe. So the SSRF guard,
  the manual redirect re-validation, and the Firecrawl empty-shell fallback all
  apply with no new code.
- It calls `web_search` for domain resolution and for the ranked fallback. It
  reuses `WebSearchResult.results` (title plus URL) to pick a domain and drill
  targets.
- It adds no credential. It reads public URLs only.

## Metering and audit

Every `fetch_url` and `web_search` call already writes its own `api_call_log`
row through the metered path. Pass the `runId` and `stepId` so the rollup
attributes each probe to the run. The `probed` list is the human-readable trail.

## Non-goals

- No citation UI. That is the separate citation primitive. Discovery feeds it
  later; for now it returns raw sources.
- No crawler. The tool probes a small fixed path set, not a whole site.
- No new JS engine. The existing Firecrawl fallback is the only render path.
- No third-party research. Scope stays on the named subject's own sources.

## Acceptance test

Add a smoke script under `packages/api/src/scripts/`, in the
`smoke-fetch-url.ts` pattern.

- Input: `{ subject: "Vercel's design system", intent: "resume design tokens" }`.
- Expect `sources` to contain `https://vercel.com/design.md` with
  `kind: "markdown_page"`.
- Expect `probed` to record the `/llms.txt` hit and the `/design.md` hit.

Add a deterministic eval in the `boss-judgment.eval.ts` pattern. The scorer
checks one fact: the trajectory fetched the manifest path, not only a ranked
page.

## Open questions

1. **Domain resolution home.** Does the tool resolve the domain, or does the
   boss pass it? Recommendation: the tool resolves it, so the boss makes one
   clean call.
2. **Budget size.** Start at 8 probes. Tune it from real traces.
3. **Citation feed.** Return raw sources now. Wire them to the citation
   primitive when that lands.
