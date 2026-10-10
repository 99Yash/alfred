import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { safeJsonParse } from "@alfred/contracts";
import { cloudflareGatewayConfig, serverEnv } from "@alfred/env/server";
import type { APICallError } from "ai";
import { z } from "zod";

import { throttledGatewayFetch } from "./gateway-throttle";
import {
  type TranscribeAudioResult,
  transcribeViaCloudflareRun,
  transcribeWithOpenAi,
} from "./transcription";

/**
 * The one place that picks host, credential, and model name for every model call:
 * "direct" (SDK defaults) or "cloudflare" (Unified Billing). Built from config, no module state.
 * Audio uses Cloudflare's `/ai/run` instead; see `transcription.ts`.
 */
export type GatewayConfig = NonNullable<ReturnType<typeof cloudflareGatewayConfig>>;

export interface Gateway {
  readonly kind: "direct" | "cloudflare";
  createAnthropic(): ReturnType<typeof createAnthropic>;
  createOpenAI(): ReturnType<typeof createOpenAI>;
  createGoogle(): ReturnType<typeof createGoogleGenerativeAI>;
  transcribe(audio: Uint8Array): Promise<TranscribeAudioResult>;
}

function gatewayBaseUrl(cfg: GatewayConfig, providerSegment: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/${providerSegment}`;
}

function gatewayHeaders(token: string) {
  return { "cf-aig-authorization": `Bearer ${token}` } satisfies Record<string, string>;
}

/**
 * Strip the SDK's dummy `Authorization` header. If it reaches Cloudflare, it is forwarded
 * to OpenAI as is, and OpenAI rejects it. Only OpenAI uses that header for auth.
 */
function openaiGatewayFetch(token: string): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("cf-aig-authorization", `Bearer ${token}`);

    return fetch(input, { ...init, headers });
  };
}

const gatewayErrorBodySchema = z.object({ internalCode: z.number() });

/**
 * The Cloudflare edge made this error itself: its `AiGatewayError` body carries a top-level
 * numeric `internalCode` (`2003` and `2018` are 429s, `2021` is the Unified Billing credit
 * 402). A provider error body has no such field.
 */
export function isGatewayMintedError(e: APICallError): boolean {
  return gatewayErrorBodySchema.safeParse(safeJsonParse(e.responseBody ?? "")).success;
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

  // One queue for all providers: the budget is per gateway (see `gateway-throttle.ts`).
  const requestsPerMinute = serverEnv().CLOUDFLARE_AI_GATEWAY_RPM;
  const burst = serverEnv().CLOUDFLARE_AI_GATEWAY_BURST;

  const throttleConfig = {
    accountId: config.accountId,
    gatewayId: config.gatewayId,

    ...(requestsPerMinute === undefined ? {} : { requestsPerMinute }),
    ...(burst === undefined ? {} : { burst }),
  };

  const paced = (inner?: typeof globalThis.fetch) => throttledGatewayFetch(throttleConfig, inner);

  const cfAnthropic = createAnthropic({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "anthropic"),
    headers: gatewayHeaders(config.token),
    fetch: paced(),
  });

  // No `headers`: `openaiGatewayFetch` sets `cf-aig-authorization`.
  const cfOpenAI = createOpenAI({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "openai"),
    fetch: paced(openaiGatewayFetch(config.token)),
  });

  const cfGoogle = createGoogleGenerativeAI({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "google-ai-studio/v1beta"),
    headers: gatewayHeaders(config.token),
    fetch: paced(),
  });

  return {
    kind: "cloudflare",
    createAnthropic: () => cfAnthropic,
    createOpenAI: () => cfOpenAI,
    createGoogle: () => cfGoogle,
    // `/ai/run` draws on the same gateway budget, so it is paced too.
    transcribe: (audio) => transcribeViaCloudflareRun(config, audio, paced()),
  };
}

/** The only reader of `cloudflareGatewayConfig()` in this package. */
export function activeGateway(): Gateway {
  return createGateway(cloudflareGatewayConfig());
}

/** Cloudflare needs no provider key; direct needs `OPENAI_API_KEY`. */
export function transcriptionConfigured(): boolean {
  return cloudflareGatewayConfig() !== undefined || serverEnv().OPENAI_API_KEY !== undefined;
}

export async function transcribeAudio(audio: Uint8Array): Promise<TranscribeAudioResult> {
  return await activeGateway().transcribe(audio);
}
