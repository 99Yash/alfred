import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { cloudflareGatewayConfig, serverEnv } from "@alfred/env/server";

import {
  type TranscribeAudioResult,
  transcribeViaCloudflareRun,
  transcribeWithOpenAi,
} from "./transcription";

/**
 * Deep module owning the Cloudflare AI Gateway transport choice. Every call
 * that leaves this process for a model — a chat completion, an enrichment, a
 * transcription — picks its host, its credential and its model name here, and
 * nowhere else.
 *
 * Two adapters: "direct" (SDK defaults) vs "cloudflare" (Unified Billing via
 * `gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}` with
 * `cf-aig-authorization`). No module-level mutable singletons — creation is
 * pure from config.
 *
 * Audio is the one exception to that base URL, and it is a Cloudflare
 * constraint, not a choice: `gateway.ai.cloudflare.com/…/openai/…` carries a
 * managed credential on `/chat/completions` and `/responses` only, so speech
 * to text goes to `api.cloudflare.com/client/v4/accounts/{account}/ai/run`
 * with `cf-aig-gateway-id` instead. `transcription.ts` states the full
 * reason. The exception lives on `transcribe` below, so a reader finds it on
 * the same interface as the rest of the transport.
 */
export type GatewayConfig = NonNullable<ReturnType<typeof cloudflareGatewayConfig>>;

export interface Gateway {
  readonly kind: "direct" | "cloudflare";
  createAnthropic(): ReturnType<typeof createAnthropic>;
  createOpenAI(): ReturnType<typeof createOpenAI>;
  createGoogle(): ReturnType<typeof createGoogleGenerativeAI>;
  /**
   * Speech to text over this transport. A member rather than a free function
   * so a caller asks the active gateway for a transcript and never re-derives
   * which endpoint, model or credential the clip needs.
   */
  transcribe(audio: Uint8Array): Promise<TranscribeAudioResult>;
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
      transcribe: (audio) => transcribeWithOpenAi(openai, audio),
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
  // No `headers` option here: `openaiGatewayFetch` already sets
  // `cf-aig-authorization` on every request, and two writers of one header is
  // a question a reader should not have to answer.
  const cfOpenAI = createOpenAI({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "openai"),
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
    transcribe: (audio) => transcribeViaCloudflareRun(config, audio),
  };
}

/**
 * The gateway this process's environment selects. One reader of
 * `cloudflareGatewayConfig()` for the whole package, so "are we on Cloudflare"
 * is answered in one place.
 */
export function activeGateway(): Gateway {
  return createGateway(cloudflareGatewayConfig());
}

/**
 * Whether a transcription call can reach a provider at all. The Cloudflare
 * transport needs no provider key; the direct one needs `OPENAI_API_KEY`.
 *
 * Exported so a route gates on the rule instead of restating it: a caller that
 * re-derives this pair gets a provider throw the day either transport changes.
 */
export function transcriptionConfigured(): boolean {
  return cloudflareGatewayConfig() !== undefined || serverEnv().OPENAI_API_KEY !== undefined;
}

/** Transcribe a clip over whichever transport the environment selects. */
export async function transcribeAudio(audio: Uint8Array): Promise<TranscribeAudioResult> {
  return await activeGateway().transcribe(audio);
}
