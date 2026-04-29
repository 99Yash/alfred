# Dimension.dev Recon

## Scope

This write-up is based on:

- Public HTML, JS bundles, build manifests, and response headers from `dimension.dev`
- Direct inspection of a logged-in browser session via Chrome DevTools Protocol (CDP)
- Runtime network requests observed from authenticated app pages
- Bundle-string analysis from downloaded production chunks

This is not a backend pentest. Anything about GKE, microservice boundaries, databases, or internal service topology beyond what the frontend reveals should be treated as inference unless explicitly marked as user-provided context.

## TL;DR

Dimension's public web tier is a statically exported Next.js app served from Vercel, while the actual product behavior is heavily client-hydrated through same-origin `tRPC` calls and a realtime/sync layer that includes Ably and Replicache. The logged-in app is substantially larger than the marketing site and includes chat, integrations, workflows, skills, library/artifacts, settings, morning briefings, todo management, documents, email, slides, sheets, and a large internal sandbox surface.

I did not find publicly exposed production source maps for the key bundles I checked (`main`, `_app`, and authenticated `chat` page chunks all returned `404`). Even without maps, the build manifest, route list, runtime RPC names, and authenticated DOM/network traffic leak a lot of architectural detail.

## Confirmed Findings

### 1. Public delivery stack

- `dimension.dev` is served by Vercel.
- Response headers on bundle/map requests include `server: Vercel`.
- `GET /api/version` returns:

```json
{ "buildVersion": "dpl_2Byyf82BDLCDTTM2kvUqqf4fFDZn" }
```

- The site uses a Next.js build with build ID `DLLLlfJzubMv_j4Z8bs2T`.
- `__NEXT_DATA__` on both public and authenticated pages shows `nextExport: true`.
- `__NEXT_DATA__` on both public and authenticated pages shows `autoExport: true`.

This strongly suggests a static-export shell that hydrates into a rich client app after load.

### 2. Frontend architecture

- Framework: Next.js Pages Router, not App Router.
- Authenticated pages are still rendered as static Next pages and then hydrate client-side.
- Styling appears to be a mix of Tailwind-style utility classes and shared component styling.
- The app shell prefetches multiple major sections via `_next/data/.../*.json` and page chunks.

Observed prefetches from the authenticated shell:

- `/chat`
- `/integrations`
- `/workflows`
- `/skills`
- `/library`
- `/settings`

### 3. No public source maps found for key bundles

Checked directly and got `404` for:

- `/_next/static/chunks/main-932d0bc32d3fdc1c.js.map`
- `/_next/static/chunks/pages/_app-b43cbc88e6355cdd.js.map`
- `/_next/static/chunks/pages/chat/%5B%5B...threadId%5D%5D-e5c110749af2ee85.js.map`

Also, the inspected bundle bodies did not expose obvious `sourceMappingURL` comments.

Conclusion: production source maps do not appear to be openly published for the main/authenticated bundles I checked.

### 4. Route surface is large

The public build manifest exposed `167` routes.

Notable product routes include:

- `/chat/[[...threadId]]`
- `/integrations`
- `/integrations/<provider>`
- `/workflows`
- `/workflows/[id]`
- `/skills`
- `/skills/[id]`
- `/library/[[...artifactId]]`
- `/settings`
- `/search`
- `/documents`
- `/email`
- `/morning-briefing`
- `/todo`
- `/slides`
- `/sheets`
- `/marketplace`
- `/admin/*`
- `/auth/callback/[integrations]`
- `/auth/callback/sso`

There is also a very large sandbox/internal prototyping surface, including routes like:

- `/sandbox/hil/dimension/ask-questions`
- `/sandbox/hil/linear/create-issue`
- `/sandbox/hil/linear/update-issue`
- `/sandbox/notion-update-form`
- `/sandbox/slack-bot`
- `/sandbox/spreadsheet-streaming`
- `/sandbox/voice-input`
- `/sandbox/workflow-prompt`

This strongly suggests active internal experimentation around human-in-the-loop flows, integration actions, and agent UX.

### 5. Same-origin tRPC backend

The frontend clearly uses `tRPC` on the same origin.

Bundle evidence:

```js
function a(){
  let { NEXT_PUBLIC_API_URL:e } = ...
  return Capacitor.isNativePlatform() ? `${e}/trpc` : "/trpc"
}
```

Observed runtime requests from an authenticated page load:

- `GET /trpc/auth.getLoggedInUser`
- `POST /trpc/socket.genToken`
- `GET /trpc/stripeBilling.getCurrentSubscription`
- `GET /trpc/customIntegration.getAvailable`
- `GET /trpc/customIntegration.getConnectionStatuses`
- `GET /trpc/integration.checkGoogleScopesComplete`
- `GET /trpc/todo.getAllActive`
- `GET /trpc/todoCategory.getAll`
- `GET /trpc/morningBriefing.getToday`
- `POST /trpc/atSearch.warmIntegrationNamespaces`
- `POST /trpc/search.warmUserNamespace`
- `POST /trpc/replicache.pull`
- `POST /trpc/user.detectLocation`
- `POST /trpc/user.refreshWeather`

From bundles, additional procedure families are referenced, including:

- `replicache.push`
- `documents.getById`
- `documents.update`
- `artifacts.search`
- `artifacts.listAll`
- `artifacts.toggleFavourite`
- `todo.delete`
- `todo.update`

### 6. Realtime + sync layer: Ably and Replicache

This is one of the more interesting architectural signals.

Bundle evidence shows an Ably provider initialized with a token fetched from `socket.genToken`:

```js
new Ably.Realtime({
  authCallback: (params, cb) => {
    socket.genToken.mutate().then(({ tokenRequest }) => cb(null, tokenRequest));
  },
  autoConnect: true,
  closeOnUnload: false,
});
```

Bundle evidence also shows Replicache pull/push handlers wired into the app:

```js
replicache.push.mutate(...)
replicache.pull.mutate(...)
```

And there is domain-scoped channel behavior in the bundle:

```js
channels.get(`replicache:${domain}`).subscribe(...)
```

Inference:

- They are not doing plain REST-only polling.
- The app has an explicit realtime transport layer.
- Replicache is likely used for local-first-ish sync or optimistic/offline-friendly state replication.
- Ably likely handles subscriptions, fanout, or invalidation events.

### 7. Auth model and session behavior

Web session behavior observed:

- The authenticated app worked in the logged-in browser profile without storing obvious web auth keys in localStorage.
- Same-origin `tRPC` calls authenticated successfully from that browser session.

Bundle evidence shows native auth flows storing keys in localStorage on mobile/native paths:

```js
localStorage.setItem("auth_token", token);
localStorage.setItem("session_id", session);
```

There is also native deep-link handling:

```js
dimension://auth?token=...&session=...
dimension://integration-callback?...
```

The SSO flow is org-aware and supports email-domain disambiguation:

- The SSO page asks for work email.
- If multiple orgs match a domain, the UI renders `Multiple organizations found for this email domain. Please select one to continue.`

### 8. Cross-platform app, not just web

The bundles clearly reference Capacitor and native-only behaviors.

Observed signals:

- `Capacitor.isNativePlatform()` checks
- Native Google and Apple sign-in flows
- Push notification plugin registration
- Deep-link routing via `dimension://...`

Bundle evidence:

```js
registerPlugin("PushNotifications", {});
```

So Dimension is at least architected for:

- Web app
- Native mobile wrapper/app
- Slack and iMessage interaction surfaces

### 9. Product surface seen from the logged-in app

Authenticated shell navigation showed these major sections:

- Chat
- Integrations
- Workflows
- Skills
- Library
- Settings
- Referrals

The main chat shell also exposed visible UI concepts like:

- Search
- To Do
- Suggestions
- Weather/location widget
- Upgrade plan surface

The Workflows page copy says:

- `Create a scheduled or trigger-based workflow.`

So workflows are a first-class product concept, not just ad hoc prompts.

### 10. Integrations are a major first-class primitive

The authenticated `Integrations` page exposed a large connector catalog.

Visible connectors included:

- Google Calendar
- Gmail
- Notion
- GitHub
- Vercel
- Railway
- iMessage
- Slack Bot
- Google Drive
- Google Sheets
- Google Slides
- Google Docs
- Slack
- Granola
- Linear
- Dropbox
- Asana
- Figma
- HubSpot
- Airtable
- Ramp
- Mercury
- Stripe
- Intercom
- Sentry
- PostHog
- Supabase
- Better Stack
- Cloudflare
- Databricks
- Netlify
- MCP Server

Notable detail: `MCP Server` appears explicitly as a user-facing integration option.

That means the product is not just SaaS-connector-based; it is intentionally designed to plug into arbitrary MCP-compatible tools.

### 11. Search / documents / artifacts / generated outputs are first-class

Bundle strings and route structure strongly indicate a searchable artifact/document system.

Observed client hooks / concepts:

- `artifacts.search.useQuery`
- `artifacts.listAll.useInfiniteQuery`
- `documents.getById.useQuery`
- `documents.update.useMutation`
- `library/[[...artifactId]]`
- `artifact_id`
- `presentation_id`

There are also direct hints of generated outputs and review gates, including strings like:

- `PDF_GENERATE`
- `github_pull_request_review_write`
- `SLACK_POST_MESSAGE`
- `linear_save_issue`
- `notion-update-page`

That suggests agent/tool actions are often staged for user review before final execution.

### 12. Morning briefing and assistant UX are real product primitives

The app is not just a blank chat box. It has dedicated domains around:

- Morning briefing
- Suggested replies
- Search namespace warming
- Todo extraction/management
- Meeting/context prep

Bundle strings show features like:

- `morningBriefing.getToday`
- Gmail reply drafting with attachments
- `suggestedReply`
- Thread summary / sender metadata

This aligns with the marketing claim that the assistant is doing structured work across external systems, not just generic chatting.

### 13. Third-party services / instrumentation observed

Observed directly:

- PostHog EU (`eu.i.posthog.com`, `eu-assets.i.posthog.com`)
- Google Identity Services (`accounts.google.com/gsi/client`)
- Delve cookie consent / geo (`cdn.delve.co`, `cdn.delve.co/api/geo`)
- Ably (from bundle code)
- Replicache (from bundle code)
- Stripe billing calls (same-origin tRPC namespace)

Bundle strings also reference `Sentry` and `Intercom` integrations/libraries.

## What This Suggests About The Backend

What is directly observable:

- The browser talks to same-origin `tRPC` endpoints on `dimension.dev`.
- There is a realtime token exchange via `socket.genToken`.
- There is a Replicache sync path via `replicache.pull` and `replicache.push`.
- The frontend is delivered from Vercel.

What I would infer, cautiously:

- The Vercel-hosted frontend is probably acting as the public edge/web tier.
- Backend logic is likely behind same-origin RPC routes, either on Vercel functions, an origin proxy, or a separate service mesh behind the edge.
- Your note that the backend runs on GKE with roughly 11 microservices is plausible and consistent with the breadth of client namespaces, but the frontend alone does not prove a one-router-to-one-microservice mapping.
- The visible namespaces suggest domain separations roughly around auth, sockets/realtime, search, sync, integrations, billing, todos, briefings, user context, documents/artifacts, workflows, and notifications.

## Public Corroboration From Ronit.one

The strongest external corroboration came from `https://www.ronit.one`, the personal site of Ronit Panda, who describes himself as `Currently lead at Dimension` and `Lead Engineer · Dimension`.

Important caveat: the items below are self-published claims, not independent verification. They are still valuable because they line up closely with the runtime evidence from the shipped frontend.

Homepage claims (`https://www.ronit.one`):

- Dimension is described as `an AI chief-of-staff`.
- He explicitly claims `multi-agent architecture with sub-agent delegation`.
- He explicitly claims `workspace-wide RAG across Gmail/Slack/GitHub/Linear/Notion`.
- He explicitly claims `11 microservices on GKE with NATS JetStream`.

### Orchestration post

From `https://ronit.one/blog/agent-orch`:

- The top-level orchestrator is described as a `boss agent` using `Claude Opus`.
- Complex tasks are decomposed into parallel sub-agents.
- Sub-agents coordinate through a Redis scratchpad, not direct inter-agent messaging.
- The scratchpad has a `seven-day TTL`.
- Tool loading is lazy and integration-aware.
- Human approval is implemented as a graph interrupt primitive using `LangGraph` checkpoints.
- Long-thread compaction uses a cheaper summarizer identified as `Gemini Flash`.
- The system is explicitly said to power Dimension across `web, Slack, and iMessages`.

This matches several frontend clues already observed:

- Explicit Slack and iMessage product surfaces
- Review/approval strings for consequential actions
- Large integration-aware chat UI
- Search and artifact-oriented workflow patterns

### Search/indexing post

From `https://ronit.one/blog/context-engine-indexing`:

- Search/indexing is described as one shared architecture across multiple integrations.
- Named infra components: `NATS JetStream`, `TurboPuffer`, `KEDA`, and `Voyage embeddings`.
- Google Drive indexing is split into specialized worker queues for `PDF`, `Text`, and `Tabular` workloads.
- Workers scale from `0` based on queue depth.
- The workers are said to run on `GKE spot instances`.
- The vector model is described as `Voyage-4, 1024 dims`.
- Search is described as hybrid: semantic + BM25 + RRF + `Voyage rerank-2.5-lite`.
- Real-time indexing progress is pushed via `Ably`.

This aligns strongly with the client evidence:

- `atSearch.warmIntegrationNamespaces`
- `search.warmUserNamespace`
- explicit artifact/document/search surfaces
- Ably in the production bundle

### Memory post

From `https://ronit.one/blog/context-engine-mem`:

- Dimension's long-term memory is described as a knowledge graph built with `Zep`, backed by `Neo4j`.
- He claims `27 ingestion points` feeding the graph.
- Memory search uses hybrid retrieval: cosine similarity + BM25 + graph traversal.
- Warmed graph search latency is claimed to drop from `~3s` cold to `~400ms` warm.
- Onboarding includes web research on the user to pre-populate memory.

This is useful because it explains the product behavior without contradicting the browser evidence. The frontend never exposed Zep or Neo4j directly, but the claimed memory model fits the assistant patterns observed in chat and briefing surfaces.

### Background agents post

From `https://ronit.one/blog/background-agents`:

- Dimension uses `eight specialized agents` for recurring background work.
- The trigger pattern is described as `NATS Event -> Consumer -> Agent graph -> DB write -> Ably push`.
- Named agents include morning briefing, evening briefing, reply generator, meeting prep, action items, onboarding, skills, and a near-credit-limit upsell agent.
- The post says most of these specialized agents use `Sonnet 4.6`, while a narrower set uses `Opus 4.6`.
- Background agents are described as read-only by default, with structured terminal `DUMP_*` tools writing into database-backed schemas.

This maps neatly to runtime/frontend evidence:

- `morningBriefing.getToday`
- todo/action-item surfaces
- workflow/skills sections
- structured UI cards instead of plain-text-only outputs

### Why these posts matter

Taken together, the blog posts convert several earlier frontend inferences into publicly claimed architecture facts:

- `11 microservices on GKE` is now directly corroborated by a public first-party statement.
- `NATS JetStream` appears to be a core event backbone.
- `Ably` is not incidental; it is part of the app's progress/realtime architecture.
- `Redis`, `LangGraph`, `TurboPuffer`, `KEDA`, `Voyage`, `Zep`, and `Neo4j` all appear in public technical writing tied to Dimension's production system.
- The app appears to be architected as a multi-surface AI operating layer spanning web, Slack, and iMessage rather than a single chat frontend.

## Interesting Leaks / High-Signal Clues

- `167` routes in the build manifest, including many internal sandbox/HIL pages
- `MCP Server` exposed as a first-class integration
- Ably token generation through `socket.genToken`
- Replicache push/pull in production bundles
- Native deep links via `dimension://...`
- SSO org selection by email domain
- Strong document/artifact/presentation model in the UI and bundles
- Action-review phrasing for outbound tool operations like Slack, GitHub PR review, Linear, Notion, Airtable, and PDF generation

## Caveats

- I did not see public production source maps for the main bundles I checked.
- I did not do destructive testing or attempt unauthorized backend enumeration.
- Some conclusions are architectural inference from bundle/runtime evidence rather than direct backend visibility.
- The authenticated observations came from a live logged-in browser session, so I intentionally avoided recording private content values, tokens, or session secrets in this document.

## Bottom Line

Dimension is not a thin marketing shell over a single chat endpoint. The shipped client suggests a fairly serious system with:

- A Vercel-served static Next.js web shell
- A same-origin `tRPC` API surface
- Realtime infra via Ably
- Sync infra via Replicache
- Cross-platform web + native support via Capacitor
- A large integration graph, including MCP
- First-class workflows, artifacts/library, documents, search, briefings, and todo systems
- A substantial internal sandbox/HIL surface that points to ongoing agent-tooling iteration

If you want, the next useful pass would be a tighter namespace map: enumerate all publicly visible `tRPC` procedure names from the downloaded chunks and group them into likely backend domains.
