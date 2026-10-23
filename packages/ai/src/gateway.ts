import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { parseJsonWith } from "@alfred/contracts";
import { cloudflareGatewayConfig, serverEnv } from "@alfred/env/server";
import type { APICallError } from "ai";
import { Agent } from "undici";
import { z } from "zod";

import { throttledGatewayFetch } from "./gateway-throttle";
import { type TranscribeAudioResult, transcribeViaCloudflareRun } from "./transcription";

/**
 * The one place that picks host, credential, and model name for every model call. Every call
 * goes through the Cloudflare AI Gateway (Unified Billing); there are no direct provider keys.
 * Built from config; the only module state is the connection pool below.
 * Audio uses Cloudflare's `/ai/run` instead; see `transcription.ts`.
 */
export type GatewayConfig = NonNullable<ReturnType<typeof cloudflareGatewayConfig>>;

export interface Gateway {
  createAnthropic(): ReturnType<typeof createAnthropic>;
  createOpenAI(): ReturnType<typeof createOpenAI>;
  createGoogle(): ReturnType<typeof createGoogleGenerativeAI>;
  transcribe(audio: Uint8Array): Promise<TranscribeAudioResult>;
}

function gatewayBaseUrl(cfg: GatewayConfig, providerSegment: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/${providerSegment}`;
}

/**
 * `cf-aig-skip-cache` keeps every model call off the gateway response cache, whatever the
 * dashboard says. The cache key is the exact body, so a retry of an empty or malformed
 * answer would replay that same answer.
 */
function gatewayHeaders(token: string) {
  return {
    "cf-aig-authorization": `Bearer ${token}`,
    "cf-aig-skip-cache": "true",
  } satisfies Record<string, string>;
}

/**
 * Cloudflare sends no `Keep-Alive: timeout=` hint, so global `fetch` falls back to undici's
 * 4 s default and drops the socket between most turns. A new TLS connection to the gateway
 * costs about 140 ms more than a reused one. Keep idle sockets for 4 minutes instead.
 * Measured on 2026-10-22: Cloudflare kept a socket idle for 300 s and closed one idle for 400 s.
 * Close first, well under that, so a POST never lands on a socket the edge has just closed.
 * One pool per process, because `activeGateway()` builds a new `Gateway` for every call.
 */
const GATEWAY_KEEP_ALIVE_MS = 240_000;

const gatewayDispatcher = new Agent({ keepAliveTimeout: GATEWAY_KEEP_ALIVE_MS });

/** Global `fetch` on the gateway's pool. */
const pooledFetch: typeof globalThis.fetch = (input, init) => {
  const withDispatcher: Omit<RequestInit, "dispatcher"> & { dispatcher: unknown } = {
    ...init,
    dispatcher: gatewayDispatcher,
  };

  // SAFETY: Node's fetch accepts undici's `dispatcher`; only its `undici-types` copy differs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- @types/node types `dispatcher` from undici-types, which the undici Agent does not satisfy
  return fetch(input, withDispatcher as RequestInit);
};

/**
 * Strip the SDK's dummy `Authorization` header. If it reaches Cloudflare, it is forwarded
 * to OpenAI as is, and OpenAI rejects it. Only OpenAI uses that header for auth.
 */
function openaiGatewayFetch(token: string): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");

    for (const [name, value] of Object.entries(gatewayHeaders(token))) headers.set(name, value);

    return pooledFetch(input, { ...init, headers });
  };
}

const gatewayErrorBodySchema = z.object({ internalCode: z.number() });

/**
 * The Cloudflare edge made this error itself: its `AiGatewayError` body carries a top-level
 * numeric `internalCode` (`2003` and `2018` are 429s, `2021` is the Unified Billing credit
 * 402). A provider error body has no such field.
 */
export function isGatewayMintedError(e: APICallError): boolean {
  return parseJsonWith(e.responseBody ?? "", gatewayErrorBodySchema) !== null;
}

function createGateway(config: GatewayConfig): Gateway {
  // One queue for all providers: the budget is per gateway (see `gateway-throttle.ts`).
  const requestsPerMinute = serverEnv().CLOUDFLARE_AI_GATEWAY_RPM;
  const burst = serverEnv().CLOUDFLARE_AI_GATEWAY_BURST;

  const throttleConfig = {
    accountId: config.accountId,
    gatewayId: config.gatewayId,

    ...(requestsPerMinute === undefined ? {} : { requestsPerMinute }),
    ...(burst === undefined ? {} : { burst }),
  };

  const paced = (inner: typeof globalThis.fetch = pooledFetch) =>
    throttledGatewayFetch(throttleConfig, inner);

  const cfAnthropic = createAnthropic({
    apiKey: config.token,
    baseURL: gatewayBaseUrl(config, "anthropic"),
    headers: gatewayHeaders(config.token),
    fetch: paced(),
  });

  // No `headers`: `openaiGatewayFetch` sets the gateway headers.
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
    createAnthropic: () => cfAnthropic,
    createOpenAI: () => cfOpenAI,
    createGoogle: () => cfGoogle,
    // `/ai/run` draws on the same gateway budget, so it is paced too.
    transcribe: (audio) => transcribeViaCloudflareRun(config, audio, paced()),
  };
}

function gatewayNotConfiguredError(): Error {
  return new Error(
    "[gateway] Cloudflare AI Gateway is not configured: set CLOUDFLARE_AI_GATEWAY_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_GATEWAY_ID",
  );
}

/** Refuses every request, so a model call without the gateway fails with a named error. */
const refuseFetch: typeof globalThis.fetch = () => Promise.reject(gatewayNotConfiguredError());

/**
 * Without config, handles still build: modules make route handles at import time, and the
 * `@alfred/http` barrel must load with no env. The first request fails instead.
 * `serverEnv()` requires the config outside tests, so only a test can reach this.
 */
function unconfiguredGateway(): Gateway {
  // The SDKs read the key before they fetch; this placeholder only lets `refuseFetch` run.
  const apiKey = "gateway-not-configured";

  return {
    createAnthropic: () => createAnthropic({ apiKey, fetch: refuseFetch }),
    createOpenAI: () => createOpenAI({ apiKey, fetch: refuseFetch }),
    createGoogle: () => createGoogleGenerativeAI({ apiKey, fetch: refuseFetch }),
    transcribe: () => Promise.reject(gatewayNotConfiguredError()),
  };
}

/** The only reader of `cloudflareGatewayConfig()` in this package. */
export function activeGateway(): Gateway {
  const config = cloudflareGatewayConfig();

  return config ? createGateway(config) : unconfiguredGateway();
}

/** Whether voice input can run: it needs the gateway like every model call. */
export function transcriptionConfigured(): boolean {
  return cloudflareGatewayConfig() !== undefined;
}

export async function transcribeAudio(audio: Uint8Array): Promise<TranscribeAudioResult> {
  return await activeGateway().transcribe(audio);
}
