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

function gatewayHeaders(token: string): Record<string, string> {
  return { "cf-aig-authorization": `Bearer ${token}` };
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
