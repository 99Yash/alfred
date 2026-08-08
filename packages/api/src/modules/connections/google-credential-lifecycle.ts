import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import { getFreshAccessToken, stopGmailWatchWithAccessToken } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { TriggerConsumerBootError } from "@alfred/assistant/triggers";

const identifierSchema = z.string().min(1).max(500);

export const googleCredentialUpsertRequestSchema = z
  .object({
    userId: identifierSchema,
    accountId: identifierSchema,
    accountEmail: z.string().min(1).max(500),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.date(),
    scopes: z.array(z.string()).max(500),
    tokenType: z.string().min(1).max(100),
    hostedDomain: z.string().min(1).max(253).nullable(),
  })
  .strict();

const googleCredentialUpsertHandlerRequestSchema = googleCredentialUpsertRequestSchema
  .extend({ changedAt: z.date() })
  .strict();

type GoogleCredentialUpsertHandlerRequest = z.infer<
  typeof googleCredentialUpsertHandlerRequestSchema
>;

const googleCredentialUpsertResultSchema = z.object({ credentialId: identifierSchema }).strict();

export type GoogleCredentialUpsertResult = z.infer<typeof googleCredentialUpsertResultSchema>;

export const googleCredentialDisconnectRequestSchema = z
  .object({
    userId: identifierSchema,
    credentialId: identifierSchema,
  })
  .strict();

export type GoogleCredentialDisconnectRequest = z.infer<
  typeof googleCredentialDisconnectRequestSchema
>;

const googleCredentialDisconnectHandlerRequestSchema = googleCredentialDisconnectRequestSchema
  .extend({ disconnectedAt: z.date() })
  .strict();

type GoogleCredentialDisconnectHandlerRequest = z.infer<
  typeof googleCredentialDisconnectHandlerRequestSchema
>;

const googleCredentialDisconnectResultSchema = z
  .object({
    credentialId: identifierSchema,
    status: z.enum(["deleted", "already_absent"]),
  })
  .strict();

export type GoogleCredentialDisconnectResult = z.infer<
  typeof googleCredentialDisconnectResultSchema
>;

export interface GoogleCredentialLifecycleHandler {
  upsert(request: GoogleCredentialUpsertHandlerRequest): Promise<GoogleCredentialUpsertResult>;
  disconnect(
    request: GoogleCredentialDisconnectHandlerRequest,
  ): Promise<{ status: GoogleCredentialDisconnectResult["status"] }>;
}

export class NoGoogleCredentialLifecycleHandlerRegisteredError extends TriggerConsumerBootError {
  constructor() {
    super("[integrations] no Google credential lifecycle handler is registered");
    this.name = "NoGoogleCredentialLifecycleHandlerRegisteredError";
  }
}

export class GoogleCredentialNotFoundError extends Error {
  constructor() {
    super("[integrations] Google credential not found");
    this.name = "GoogleCredentialNotFoundError";
  }
}

let googleCredentialLifecycleHandler: GoogleCredentialLifecycleHandler | undefined;

export function registerGoogleCredentialLifecycleHandler(
  handler: GoogleCredentialLifecycleHandler,
): () => void {
  if (googleCredentialLifecycleHandler) {
    throw new Error("[integrations] a Google credential lifecycle handler is already registered");
  }
  googleCredentialLifecycleHandler = handler;

  return () => {
    if (googleCredentialLifecycleHandler === handler) {
      googleCredentialLifecycleHandler = undefined;
    }
  };
}

function requireGoogleCredentialLifecycleHandler(): GoogleCredentialLifecycleHandler {
  if (!googleCredentialLifecycleHandler) {
    throw new NoGoogleCredentialLifecycleHandlerRegisteredError();
  }
  return googleCredentialLifecycleHandler;
}

/** Commit a Google credential upsert and its affiliation lifecycle as one operation. */
export async function upsertGoogleCredentialConnection(
  request: unknown,
): Promise<GoogleCredentialUpsertResult> {
  const parsed = googleCredentialUpsertRequestSchema.parse(request);
  const result = await requireGoogleCredentialLifecycleHandler().upsert({
    ...parsed,
    changedAt: new Date(),
  });
  return googleCredentialUpsertResultSchema.parse(result);
}

interface GoogleCredentialDisconnectDeps {
  loadOwnedCredential(request: GoogleCredentialDisconnectRequest): Promise<boolean>;
  mailboxWritesEnabled(): boolean;
  getFreshAccessToken(credentialId: string): Promise<string>;
  commitDisconnect(
    request: GoogleCredentialDisconnectHandlerRequest,
  ): Promise<{ status: GoogleCredentialDisconnectResult["status"] }>;
  stopWatch(request: { accessToken: string; credentialId: string }): Promise<unknown>;
  now(): Date;
  warn(label: string, error: unknown): void;
}

const DEFAULT_DISCONNECT_DEPS: GoogleCredentialDisconnectDeps = {
  async loadOwnedCredential(request) {
    const [row] = await db()
      .select({ id: integrationCredentials.id })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.id, request.credentialId),
          eq(integrationCredentials.userId, request.userId),
          eq(integrationCredentials.provider, "google"),
        ),
      )
      .limit(1);
    return Boolean(row);
  },
  mailboxWritesEnabled: gmailMailboxWritesEnabled,
  getFreshAccessToken,
  async commitDisconnect(request) {
    return requireGoogleCredentialLifecycleHandler().disconnect(request);
  },
  stopWatch: stopGmailWatchWithAccessToken,
  now: () => new Date(),
  warn(label, error) {
    console.warn(`[google.disconnect] ${label}:`, toMessage(error));
  },
};

/** Internal seam for focused ordering and external-provider failure tests. */
export async function disconnectGoogleCredentialConnectionWith(
  request: GoogleCredentialDisconnectRequest,
  deps: GoogleCredentialDisconnectDeps,
): Promise<GoogleCredentialDisconnectResult> {
  if (!(await deps.loadOwnedCredential(request))) throw new GoogleCredentialNotFoundError();

  let watchStopAccessToken: string | null = null;
  if (deps.mailboxWritesEnabled()) {
    try {
      watchStopAccessToken = await deps.getFreshAccessToken(request.credentialId);
    } catch (error) {
      deps.warn("resolve watch token", error);
    }
  }

  const handlerResult = await deps.commitDisconnect({
    ...request,
    disconnectedAt: deps.now(),
  });
  const result = googleCredentialDisconnectResultSchema.parse({
    credentialId: request.credentialId,
    status: handlerResult.status,
  });

  if (watchStopAccessToken) {
    try {
      await deps.stopWatch({
        accessToken: watchStopAccessToken,
        credentialId: request.credentialId,
      });
    } catch (error) {
      deps.warn("stop watch", error);
    }
  }

  return result;
}

/** Disconnect an owned Google credential, then stop its remote watch after commit. */
export async function disconnectGoogleCredentialConnection(
  request: unknown,
): Promise<GoogleCredentialDisconnectResult> {
  return disconnectGoogleCredentialConnectionWith(
    googleCredentialDisconnectRequestSchema.parse(request),
    DEFAULT_DISCONNECT_DEPS,
  );
}
