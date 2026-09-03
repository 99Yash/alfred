import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { cloudflareGatewayConfig } from "@alfred/env/server";

/**
 * Deep module owning the Cloudflare AI Gateway transport choice.
 *
 * Two adapters: "direct" (SDK defaults) vs "cloudflare" (Unified Billing via
 * `gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}` with
 * `cf-aig-authorization`). No module-level mutable singletons — creation is
 * pure from config.
 */
export type GatewayConfig = NonNullable<ReturnType<typeof cloudflareGatewayConfig>>;

export interface Gateway {
  readonly kind: "direct" | "cloudflare";
  createAnthropic(): ReturnType<typeof createAnthropic>;
  createOpenAI(): ReturnType<typeof createOpenAI>;
  createGoogle(): ReturnType<typeof createGoogleGenerativeAI>;
}

function gatewayBaseUrl(cfg: GatewayConfig, providerSegment: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/${providerSegment}`;
}

function gatewayHeaders(token: string) {
  return { "cf-aig-authorization": `Bearer ${token}` } satisfies Record<string, string>;
}

/**
 * Unified Billing on the provider-native surface authenticates via
 * `cf-aig-authorization` alone. A request carrying the provider-native
 * `Authorization` header is forwarded to OpenAI unchanged (credential
 * precedence rule 1 — BYOK and Unified Billing are not consulted), so the
 * `cfut_` dummy the SDK requires in `apiKey` must never reach the wire or
 * OpenAI rejects the call. Strip it here, mirroring Cloudflare's own
 * `ai-gateway-provider` (dummy key plus header strip).
 *
 * Scoped to OpenAI: it is the only provider whose native auth is the
 * `Authorization` header. Anthropic (`x-api-key`) and Google
 * (`x-goog-api-key`) ride `cf-aig-authorization` into Unified Billing with
 * the `headers` option today, so they are left untouched.
 */
function openaiGatewayFetch(token: string): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("cf-aig-authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

export function createGateway(config: GatewayConfig | undefined): Gateway {
  if (!config) {
    return {
      kind: "direct",
      createAnthropic: () => anthropic,
      createOpenAI: () => openai,
      createGoogle: () => google,
    };
  }
  // Create once per Gateway instance — stateless from caller's view; no
  // module-level `let _cfAnthropic` needed. Each factory closes over its own
  // configured client rather than a lazy global.
  const cfAnthropic = createAnthropic({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "anthropic"),
    headers: gatewayHeaders(config.token),
  });
  const cfOpenAI = createOpenAI({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "openai"),
    headers: gatewayHeaders(config.token),
    fetch: openaiGatewayFetch(config.token),
  });
  const cfGoogle = createGoogleGenerativeAI({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "google-ai-studio/v1beta"),
    headers: gatewayHeaders(config.token),
  });
  return {
    kind: "cloudflare",
    createAnthropic: () => cfAnthropic,
    createOpenAI: () => cfOpenAI,
    createGoogle: () => cfGoogle,
  };
}
