# Cloudflare AI Gateway + Vercel AI SDK: correct provider wiring for Unified Billing

Status: researched 2026-08-28

Scope: how to point `@ai-sdk/anthropic`, `@ai-sdk/openai`, and `@ai-sdk/google`
at Cloudflare AI Gateway with Unified Billing (the `cfut_` token), with the
minimum of custom code. This is about the wiring at the provider-construction
seam in `packages/ai`; it does not cover gateway setup, credit loading, or BYOK.

Primary-source snapshots:

- Cloudflare AI Gateway — Unified Billing (credential precedence, provider-native
  endpoints, `cf-aig-authorization`):
  https://developers.cloudflare.com/ai-gateway/features/unified-billing/
  (updated 2026-08-07)
- Cloudflare AI Gateway — Authenticated Gateway (`cf-aig-authorization` vs REST
  `Authorization`, "use the REST API for new integrations", a Vercel AI SDK
  example): https://developers.cloudflare.com/ai-gateway/configuration/authentication/
  (updated 2026-06-17)
- Cloudflare AI Gateway — REST API (endpoints table, auth via `Authorization`,
  OpenAI-SDK and Anthropic-SDK examples):
  https://developers.cloudflare.com/ai-gateway/usage/rest-api/
  (updated 2026-08-12)
- Cloudflare AI Gateway — provider page, OpenAI:
  https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
- Cloudflare AI Gateway — provider page, Anthropic:
  https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
- Cloudflare AI Gateway — provider page, Google AI Studio:
  https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/
- Cloudflare AI Gateway — Getting started (provider-auth options, provider-specific
  endpoint shape): https://developers.cloudflare.com/ai-gateway/get-started/
- Cloudflare AI Gateway — Vercel AI SDK integration (first-party
  `ai-gateway-provider`): https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/
- Cloudflare AI Gateway — Unified API (OpenAI compat) endpoint, now deprecated for
  single-model calls: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
- Cloudflare first-party package source:
  `ai-gateway-provider` README — https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/README.md;
  `src/index.ts` — https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/index.ts;
  `src/auth.ts` — https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/auth.ts;
  canonical provider registry — https://github.com/cloudflare/ai/blob/main/packages/gateway-core/src/gateway-providers.ts
- Vercel AI SDK — community provider page for Cloudflare AI Gateway:
  https://ai-sdk.dev/providers/community-providers/cloudflare-ai-gateway

Local SDK source consulted (installed in this repo, `packages/ai/node_modules`
and `node_modules/.pnpm`): `@ai-sdk/provider-utils` (`FetchFunction`),
`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` (`dist/index.js` and
`.d.ts`) — for `LoadAPIKeyError` behavior, `baseURL` defaults, header
construction, and request-path construction.

## Conclusion

The dummy-key + header-stripping `cfFetch` is **only** an artifact of the
provider-native surface (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}`).
Cloudflare now recommends a different surface for new integrations — the REST
API at `api.cloudflare.com/client/v4/accounts/{account}/ai/v1` — where the
`cfut_` token is passed as the **native** `Authorization: Bearer <token>` header
and no `cf-aig-authorization`, no dummy key, no custom fetch, and no casts are
needed ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/),
[REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

Per provider, the minimal correct config is:

- **OpenAI** — REST API: `createOpenAI({ apiKey: cfToken, baseURL: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1" })`.
  The token goes out as `Authorization: Bearer <cfToken>`. This is Cloudflare's
  own example ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/),
  [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
  No fetch, no dummy, no casts. Model ids are provider-prefixed
  (`openai/…`, `google/…`, `anthropic/…`), and `OpenAIChatModelId` is an open
  union ending in `(string & {})`, so prefixed ids need no cast.
- **Anthropic** — REST API: `createAnthropic({ authToken: cfToken, baseURL: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1" })`.
  `authToken` maps to `Authorization: Bearer <cfToken>` (verified in
  `@ai-sdk/anthropic` source) and the provider posts to `${baseURL}/messages`,
  which lands on the REST API's `/ai/v1/messages` Anthropic-compatible endpoint.
  No fetch, no dummy, no casts. (Cloudflare's raw-`@anthropic-ai/sdk` example
  uses `apiKey` — i.e. `x-api-key` — instead; the REST API accepts that too on
  the messages endpoint, but `authToken` matches the REST API's documented
  `Authorization` auth.)
- **Google** — there is **no Google-native REST endpoint**; the REST API's four
  endpoints are `/ai/run`, `/ai/v1/chat/completions`, `/ai/v1/responses`, and
  `/ai/v1/messages` ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).
  Two clean options: (a) call Google models through the OpenAI-compatible
  endpoint with `@ai-sdk/openai` and `model: "google/gemini-…"` (single provider
  path, no hack), or (b) keep `@ai-sdk/google` pointed at the provider-native
  `…/google-ai-studio` endpoint, which requires the `cf-aig-authorization`
  header (via the `headers` option) and still needs an `apiKey` value to satisfy
  the SDK. Option (a) is the no-hack path.

So, concretely:

- The **custom fetch can be dropped** in all cases: on the REST API surface the
  token is the native key; on the provider-native surface the
  `cf-aig-authorization` header can be set with the provider's first-class
  `headers` option (all three providers spread `...options.headers` into the
  request headers after their own auth header).
- The **dummy key can be dropped** for OpenAI and Anthropic on the REST API
  surface (the `cfut_` token *is* the key/`authToken`). It cannot be fully
  dropped on the provider-native surface, because the `@ai-sdk/*` providers call
  `loadApiKey` and throw `LoadAPIKeyError` at request time when no key is
  supplied. For Google, it is dropped by switching to `@ai-sdk/openai` on the
  REST API.
- **No casts are needed** anywhere: `cf(modelId)` returns the same
  `Experimental_BatchLanguageModelV4` / `LanguageModelV4` type as the direct
  provider call, and a custom fetch declared as `FetchFunction =
  typeof globalThis.fetch` needs no cast.

## The three surfaces, and which auth each wants

Cloudflare's docs describe three different request surfaces with three different
auth stories. The current Alfred code is on surface (2); the clean answer is
surface (1).

### 1. REST API — `api.cloudflare.com/client/v4/accounts/{account}/ai/*`

Four endpoints: `/ai/run` (universal envelope), `/ai/v1/chat/completions`
(OpenAI-compatible), `/ai/v1/responses` (OpenAI Responses), `/ai/v1/messages`
(Anthropic Messages) ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

Auth: a Cloudflare API token in the standard `Authorization` header. The
Authentication page states the recommendation explicitly: "For new integrations,
we recommend using the REST API at `api.cloudflare.com`, which uses the standard
`Authorization` header" ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).

Third-party models use `author/model` ids — `openai/…`, `anthropic/…`,
`google/…`, `xai/…` — and are billed via Unified Billing; "No provider SDKs or
API keys are needed" ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

Streaming is supported (`"stream": true` appears in the `/ai/v1/chat/completions`
example) ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

### 2. Provider-native endpoints — `gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}`

Shape per provider (all from the provider pages):

- OpenAI: `…/openai`, with `/openai/chat/completions` and `/openai/responses`
  ([OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)).
- Anthropic: `…/anthropic`, with `/anthropic/v1/messages`
  ([Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)).
- Google AI Studio: `…/google-ai-studio`, with the versioned path appended by the
  caller — the docs show `…/google-ai-studio/v1/models/{model}:{resource}`
  ([Google AI Studio](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)).

Auth: `cf-aig-authorization: Bearer <token>` is the gateway auth header; the
provider key goes in the provider's native header, or is omitted entirely for
BYOK/Unified Billing ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/),
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)).

The credential-precedence rule from Unified Billing: "1. Provider key on the
request — if the request carries provider authentication (for example, an
`Authorization` header), AI Gateway forwards it to the provider unchanged. BYOK
and Unified Billing are not consulted." ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)).

### 3. Universal envelope endpoint — `gateway.ai.cloudflare.com/v1/{account}/{gateway}`

This is what Cloudflare's own `ai-gateway-provider` package POSTs to: a JSON
array of `{ endpoint, headers, provider, query }` descriptors, authenticated
with `cf-aig-authorization: Bearer <token>`, with the winning fallback step
returned via `cf-aig-step` ([`src/index.ts`](https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/index.ts)).
It is not a pass-through endpoint in the provider-native sense; it is the
machine envelope behind the package, not something you hand-wire.

## Per-provider configuration

### OpenAI (REST API — recommended)

```ts
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  apiKey: cfToken, // cfut_ token → Authorization: Bearer <cfToken>
  baseURL: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
});

// model ids are provider-prefixed and need no cast (open union):
//   openai.chat("openai/gpt-4.1")
//   openai.chat("google/gemini-3-flash")     // Google via the OpenAI-compat endpoint
//   openai.chat("anthropic/claude-sonnet-4") // Anthropic via the OpenAI-compat endpoint
```

This is Cloudflare's own example
([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/),
[Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).

### Anthropic (REST API — recommended)

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
  authToken: cfToken, // → Authorization: Bearer <cfToken> (matches REST API auth)
  baseURL: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
});

// posts to `${baseURL}/messages` → /ai/v1/messages; model id must be prefixed:
//   anthropic("anthropic/claude-sonnet-4-5")
```

`AnthropicModelId` is an open union ending in `(string & {})`, so the
`anthropic/…` prefixed id needs no cast (verified in the installed
`@ai-sdk/anthropic` `.d.ts`). Cloudflare's own REST API example uses the raw
`@anthropic-ai/sdk` with `apiKey` (→ `x-api-key`) because that SDK has no
`authToken` option; `@ai-sdk/anthropic` does, and it maps to the header the
REST API documents ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

### Google

No Google-native REST endpoint exists, so pick one:

**Option A — via the OpenAI-compatible endpoint (no hack):**

```ts
import { createOpenAI } from "@ai-sdk/openai";

const viaRest = createOpenAI({
  apiKey: cfToken,
  baseURL: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
});
// viaRest.chat("google/gemini-2.5-pro")
```

Model ids `google/…` and `google-ai-studio/…` are documented for the OpenAI-
compatible endpoints ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/),
[Unified API](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)).

**Option B — keep `@ai-sdk/google` on the provider-native endpoint:**

```ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const google = createGoogleGenerativeAI({
  apiKey: cfToken, // satisfies the SDK; sent as x-goog-api-key (see caveat below)
  baseURL: "https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/google-ai-studio/v1beta",
});
```

The `headers` option can additionally carry `cf-aig-authorization`; `@ai-sdk/google`
spreads `...options.headers` after `x-goog-api-key`, so a first-class header
works with no custom fetch (verified in the installed source). Note the docs'
BYOK/Unified-Billing example for the `@google/genai` SDK sets `apiKey:
"{cf_aig_token}"` with no extra header, i.e. it relies on the gateway accepting
the token in `x-goog-api-key` — see "Not settled" below.

## The key question: native header vs `cf-aig-authorization`

The docs contain both patterns and do not fully reconcile them:

- The cURL examples on every provider page use **`cf-aig-authorization: Bearer
  {CF_AIG_TOKEN}`** and, for Unified Billing, send **no** provider key
  ([OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
  [Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/),
  [Google AI Studio](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)).
- The SDK examples for the same provider-native endpoints instead put the
  `cfut_` token in the **native** slot: `apiKey: "{cf_api_token}"` (OpenAI →
  `Authorization`), `defaultHeaders: { Authorization: Bearer {cf_api_token} }`
  with a placeholder `apiKey` (Anthropic), and `apiKey: "{cf_aig_token}"`
  (`@google/genai` → `x-goog-api-key`) ([OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
  [Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/),
  [Google AI Studio](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)).
- The credential-precedence rule says a request carrying provider auth (e.g. an
  `Authorization` header) is forwarded to the provider unchanged
  ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)),
  which would imply the `cfut_` token in `Authorization` is *not* treated as
  gateway auth on the provider-native surface.

Cloudflare's first-party package resolves this by **never** relying on the
native header: it injects a `CF_TEMP_TOKEN` dummy key to satisfy the SDK,
strips the native auth header, and sets `cf-aig-authorization` itself
([`src/auth.ts`](https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/auth.ts),
[`src/index.ts`](https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/index.ts)).
The canonical provider registry confirms the native auth headers it strips are
`authorization` (OpenAI), `x-api-key` + `authorization` (Anthropic), and
`x-goog-api-key` + `authorization` (Google), with gateway provider ids
`openai`, `anthropic`, `google-ai-studio` ([`gateway-providers.ts`](https://github.com/cloudflare/ai/blob/main/packages/gateway-core/src/gateway-providers.ts)).

**Reading:** `cf-aig-authorization` is the authoritative gateway auth header on
`gateway.ai.cloudflare.com`. The SDK examples that stuff the token into the
native header are a documentation convenience whose reliability (native header
recognized as gateway auth, vs forwarded to the provider and rejected) is not
established by the docs. The REST API surface sidesteps the question entirely,
because there the `cfut_` token in `Authorization` *is* the documented auth.

## Why the SDKs force a key at all

All three `@ai-sdk/*` providers build their auth headers lazily via
`loadApiKey`, which throws `LoadAPIKeyError` when no `apiKey` is passed and no
env var is set (verified in the installed `@ai-sdk/provider-utils` and each
provider's `dist/index.js`). Concretely:

- `@ai-sdk/openai` — `Authorization: Bearer ${loadApiKey({ apiKey: options.apiKey, env: OPENAI_API_KEY })}`.
- `@ai-sdk/anthropic` — `authToken ? { Authorization: Bearer <authToken> } : { "x-api-key": loadApiKey({ apiKey, env: ANTHROPIC_API_KEY }) }`; it throws only if *both* `apiKey` and `authToken` are set, so `authToken` alone is a valid, key-free path.
- `@ai-sdk/google` — `"x-goog-api-key": loadApiKey({ apiKey: options.apiKey, env: GOOGLE_GENERATIVE_AI_API_KEY })`.

This is the structural reason Cloudflare's own package uses a dummy key: on the
provider-native surface you must hand the SDK *something*, and then strip it. On
the REST API surface the `cfut_` token is that something, so the dummy
disappears.

## Endpoint shapes, precisely

| Provider | Provider-native base URL | REST API equivalent |
| --- | --- | --- |
| OpenAI | `…/v1/{account}/{gateway}/openai` | `api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions` (or `/responses`) |
| Anthropic | `…/v1/{account}/{gateway}/anthropic` (→ `/anthropic/v1/messages`) | `…/ai/v1/messages` |
| Google | `…/v1/{account}/{gateway}/google-ai-studio` (→ `/google-ai-studio/v1/models/{model}:…`) | none native; use `/ai/v1/chat/completions` with `google/…` |

Sources: [OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
[Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/),
[Google AI Studio](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/),
[REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

**Google `/v1beta` vs `/v1`:** the docs build the google-ai-studio path with
`v1` (`…/google-ai-studio/v1/models/…`), while `@ai-sdk/google`'s default
`baseURL` is `https://generativelanguage.googleapis.com/v1beta` and it appends
`/models/{model}:generateContent` (verified in source). The first-party
transform is a pure host-strip — it preserves whatever version segment the SDK
produced — so `/v1beta` is what the package itself sends, which implies the
gateway passes the version through. Only `/v1` is explicitly documented;
`/v1beta` is not, so the current `/v1beta` choice is defensible but not doc-
blessed. (The standard `generateContent`/`streamGenerateContent` paths carry the
key in `x-goog-api-key`, not `?key=`; `?key=` appears only in the realtime
token and a video-uri helper, so stripping `?key=` is unnecessary for chat.)

## The first-party package: `ai-gateway-provider`

Cloudflare's official Vercel AI SDK integration is the npm package
`ai-gateway-provider`, used as:

```ts
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI } from "ai-gateway-provider/providers/openai";

const aigateway = createAiGateway({ accountId, gateway, apiKey: cfToken });
const openai = createOpenAI(); // no provider key → Unified Billing

const { text } = await generateText({ model: aigateway(openai.chat("gpt-5.1")), prompt: "…" });
```

([Vercel AI SDK integration](https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/),
[README](https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/README.md)).

Under the hood it does exactly what the Alfred branch hand-rolled: inject a
`CF_TEMP_TOKEN` key, intercept `fetch`, strip the native auth header, and POST a
provider envelope to the universal endpoint with `cf-aig-authorization`
([`src/auth.ts`](https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/auth.ts),
[`src/index.ts`](https://github.com/cloudflare/ai/blob/main/packages/ai-gateway-provider/src/index.ts)).
Adopting it would remove Alfred's hand-written fetch and casts, at the cost of a
new dependency and its fallback/routing behavior, which may be more than Alfred
wants. Routing each provider directly at the REST API is the dependency-free,
hack-free alternative.

## If a custom fetch is genuinely needed

Only if Alfred stays on the provider-native surface and wants `cf-aig-authorization`
without relying on the `headers` option. The type is `FetchFunction =
typeof globalThis.fetch` (installed `@ai-sdk/provider-utils` `dist/index.d.ts`),
so the clean signature is:

```ts
import type { FetchFunction } from "@ai-sdk/provider-utils";

const cfFetch: FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cf-aig-authorization", `Bearer ${cfToken}`);
  return fetch(input, { ...init, headers });
};
```

No casts are required; `(input: RequestInfo | URL, init?: RequestInit) =>
Promise<Response>` is structurally assignable to `typeof globalThis.fetch`. And
because `cf(modelId)` returns the same type as the direct provider call, the
`as unknown as LanguageModelV4` casts are unnecessary regardless of surface.

## Open questions / risks

- **Token permissions.** The REST API `/ai/*` endpoints require a token with
  **Account > Workers AI > Read**; "a token that holds only an AI Gateway
  permission returns 401 with error code 10000"
  ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).
  The provider-native surface wants an **AI Gateway Run** token
  ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
  A `cfut_` token minted by the gateway's "Create authentication token" flow may
  not carry Workers AI Read, so switching surfaces may require a token change.
  **Unverified from docs** whether one token serves both.
- **Native-header token on provider-native endpoints.** Unverified whether
  `apiKey: cfut_` (OpenAI/Google) or `authToken: cfut_` (Anthropic) is treated
  as gateway auth or forwarded to the provider and rejected. The
  credential-precedence rule and the SDK examples point in opposite directions.
- **Google `/v1beta`.** Only `/v1` is documented for `google-ai-studio`;
  `@ai-sdk/google` defaults to `/v1beta`. The first-party transform preserves
  `/v1beta`, suggesting pass-through, but this is not doc-blessed.
- **Streaming on the REST API** is shown for `/ai/v1/chat/completions`
  (`"stream": true`), but the `/ai/v1/responses` and `/ai/v1/messages` streaming
  behavior is not spelled out in the pages cited here — verify for
  `streamText`/`generateText` parity before switching.

## Not settled from public docs

The single biggest thing this research could not settle is whether the `cfut_`
token is **reliably** accepted in the provider's native auth header on the
provider-native `gateway.ai.cloudflare.com` endpoints (the pattern shown by the
SDK examples on the provider pages). The docs simultaneously (a) show that
pattern, (b) state that a request carrying provider auth is forwarded to the
provider unchanged, and (c) have their own first-party package strip the native
header and use `cf-aig-authorization` instead. The safe, doc-blessed answer is
the REST API surface, where the token in `Authorization` is unambiguously the
documented auth.
