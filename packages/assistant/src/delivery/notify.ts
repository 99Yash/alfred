import { db } from "@alfred/db";
import { emailSends, type NotificationKind } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, eq, ne } from "drizzle-orm";
import { getResendClient } from "./resend-client";
import { toMessage, type JsonObject } from "@alfred/contracts";
import { userIdentity } from "@alfred/assistant/settings";

/** Add a kind in `NOTIFICATION_KINDS` (`@alfred/db`), with an idempotency-key convention. */
export type { NotificationKind };

export interface NotifyArgs {
  userId: string;
  kind: NotificationKind;
  /** A repeat key for the same user is a no-op once sent. */
  idempotencyKey: string;
  subject: string;
  html: string;
  /** Required: Resend penalizes HTML-only sends. */
  text: string;
  /** Stored for replay and debugging, not sent. */
  payload?: JsonObject;
  /** Defaults to the user's account email. */
  toAddress?: string;
}

/** What a compose function hands to `notify`. */
export type ComposedEmail = Pick<NotifyArgs, "subject" | "html" | "text">;

export type NotifyResult =
  | { status: "sent"; emailSendId: string; providerMessageId: string | null }
  | { status: "duplicate"; emailSendId: string }
  | { status: "failed"; emailSendId: string; error: string };

/**
 * Send through Resend, idempotent in the DB and at the provider.
 * The row exists before the send, so a crash leaves a `queued` row to retry.
 * Resend's `Idempotency-Key` makes that retry safe if the send landed: the same body returns the
 * first response, and a re-rendered body returns `invalid_idempotent_request`, which also proves
 * the first send landed. `sent` is terminal; no later write in this function moves it.
 */
export async function notify(args: NotifyArgs): Promise<NotifyResult> {
  const env = serverEnv();

  const toAddress = args.toAddress ?? (await userIdentity({ userId: args.userId })).primaryEmail;

  // Reclaim a `queued` or `failed` row. Only a `sent` row is a duplicate.
  const upserted = await db()
    .insert(emailSends)
    .values({
      userId: args.userId,
      kind: args.kind,
      idempotencyKey: args.idempotencyKey,
      toAddress,
      subject: args.subject,
      payload: args.payload ?? {},
      status: "queued",
    })
    .onConflictDoUpdate({
      target: [emailSends.userId, emailSends.idempotencyKey],
      set: { status: "queued", error: null },
      setWhere: ne(emailSends.status, "sent"),
    })
    .returning({ id: emailSends.id });

  let emailSendId: string;

  if (upserted[0]) {
    emailSendId = upserted[0].id;
  } else {
    // Nothing returned: the row is already `sent`.
    const existing = await db()
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(
        and(eq(emailSends.userId, args.userId), eq(emailSends.idempotencyKey, args.idempotencyKey)),
      );

    const row = existing[0];

    if (!row) {
      // The row was deleted between the upsert and the select. Transient.
      throw new Error("[notify] idempotency-key conflict but no row found on lookup");
    }

    return { status: "duplicate", emailSendId: row.id };
  }

  const resend = getResendClient();
  let sendResult: Awaited<ReturnType<typeof resend.emails.send>>;

  try {
    sendResult = await resend.emails.send(
      {
        from: env.RESEND_FROM_EMAIL,
        to: toAddress,
        subject: args.subject,
        html: args.html,
        text: args.text,
        headers: {
          "X-Alfred-Idempotency-Key": args.idempotencyKey,
          "X-Alfred-Kind": args.kind,
        },
      },
      { idempotencyKey: args.idempotencyKey },
    );
  } catch (err) {
    return markFailed(emailSendId, toMessage(err));
  }

  if (sendResult.error) {
    const { name, message } = sendResult.error;

    // Resend accepted an earlier request with this key, and this retry rendered a different body
    // (the shell stamps the render time). The first request is the email the user received, so the
    // row is `sent`. Recording `failed` here would make every later retry fail the same way.
    if (name === "invalid_idempotent_request") {
      await markSent(emailSendId, null);

      return { status: "sent", emailSendId, providerMessageId: null };
    }

    // Another caller holds this key at Resend right now and owns the outcome.
    if (name === "concurrent_idempotent_requests") return { status: "duplicate", emailSendId };

    return markFailed(emailSendId, `${name}: ${message}`);
  }

  // Outside the send's `catch`: the email is out, so a failed write here must throw for a retry,
  // never record `failed`.
  const providerMessageId = sendResult.data.id;
  await markSent(emailSendId, providerMessageId);

  return { status: "sent", emailSendId, providerMessageId };
}

async function markSent(emailSendId: string, providerMessageId: string | null): Promise<void> {
  await db()
    .update(emailSends)
    .set({
      status: "sent",
      ...(providerMessageId !== null ? { providerMessageId } : {}),
      error: null,
      sentAt: new Date(),
    })
    .where(and(eq(emailSends.id, emailSendId), ne(emailSends.status, "sent")));
}

/** `sent` is terminal: a racing caller that lost at the provider must not overwrite it. */
async function markFailed(
  emailSendId: string,
  message: string,
): Promise<Extract<NotifyResult, { status: "failed" }>> {
  await db()
    .update(emailSends)
    .set({ status: "failed", error: message.slice(0, 1000) })
    .where(and(eq(emailSends.id, emailSendId), ne(emailSends.status, "sent")));

  return { status: "failed", emailSendId, error: message };
}
