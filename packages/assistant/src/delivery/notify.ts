import { db } from "@alfred/db";
import { emailSends, user, type NotificationKind } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, eq, ne } from "drizzle-orm";
import { getResendClient } from "./resend-client";
import { toMessage, type JsonObject } from "@alfred/contracts";

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
 * Resend's `Idempotency-Key` makes that retry safe if the send landed.
 */
export async function notify(args: NotifyArgs): Promise<NotifyResult> {
  const env = serverEnv();

  const toAddress = args.toAddress ?? (await resolveUserEmail(args.userId));

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

  try {
    const result = await resend.emails.send(
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

    if (result.error) {
      throw new Error(`${result.error.name}: ${result.error.message}`);
    }

    const providerMessageId = result.data?.id ?? null;
    await db()
      .update(emailSends)
      .set({
        status: "sent",
        providerMessageId,
        sentAt: new Date(),
      })
      .where(eq(emailSends.id, emailSendId));

    return { status: "sent", emailSendId, providerMessageId };
  } catch (err) {
    const message = toMessage(err);
    await db()
      .update(emailSends)
      .set({
        status: "failed",
        error: message.slice(0, 1000),
      })
      .where(eq(emailSends.id, emailSendId));

    return { status: "failed", emailSendId, error: message };
  }
}

async function resolveUserEmail(userId: string): Promise<string> {
  const rows = await db().select({ email: user.email }).from(user).where(eq(user.id, userId));
  const row = rows[0];

  if (!row) throw new Error(`[notify] user not found: ${userId}`);

  return row.email;
}
