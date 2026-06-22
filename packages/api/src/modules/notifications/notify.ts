import { db } from "@alfred/db";
import { emailSends, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, eq, ne } from "drizzle-orm";
import { getResendClient } from "./resend-client";
import { toMessage } from "@alfred/contracts";

/**
 * Logical kinds of notification. Each maps to a row in `email_sends`
 * via its `kind` column. Adding a new kind: extend this union and pick
 * an idempotency-key convention (see `notifications.ts` schema doc).
 */
export type NotificationKind = "briefing" | "evening_recap" | "approval" | "skill_documented";

export interface NotifyArgs {
  userId: string;
  kind: NotificationKind;
  /**
   * Stable per-(user, kind) key. A second call with the same key on
   * the same user is a no-op — the unique index on `email_sends`
   * absorbs duplicates without hitting Resend.
   */
  idempotencyKey: string;
  subject: string;
  html: string;
  /** Plain-text alternate body. Required — Resend penalises HTML-only sends. */
  text: string;
  /**
   * Render input retained on the row so a failed send can be replayed
   * or debugged later. Not used for delivery itself.
   */
  payload?: Record<string, unknown>;
  /** Optional override; defaults to the user's account email. */
  toAddress?: string;
}

export type NotifyResult =
  | { status: "sent"; emailSendId: string; providerMessageId: string | null }
  | { status: "duplicate"; emailSendId: string }
  | { status: "failed"; emailSendId: string; error: string };

/**
 * Send a transactional email through Resend with idempotency-keyed
 * delivery. Three phases:
 *
 *   1. Insert `email_sends` row (`status='queued'`) with
 *      `onConflictDoNothing` on `(user_id, idempotency_key)`. A conflict
 *      means we've already attempted this send; we short-circuit with
 *      `status='duplicate'` instead of re-sending.
 *   2. POST to Resend.
 *   3. Update the row to `'sent'` (with provider id) or `'failed'`
 *      (with truncated error).
 *
 * The two-phase shape matters: a row exists before the network call,
 * so a crash between step 2 and step 3 leaves a `'queued'` row that an
 * operator can inspect rather than a silent loss. The idempotency key
 * means re-running the producer doesn't double-send — it returns
 * `'duplicate'` on the next attempt.
 */
export async function notify(args: NotifyArgs): Promise<NotifyResult> {
  const env = serverEnv();

  const toAddress = args.toAddress ?? (await resolveUserEmail(args.userId));

  // Insert the row, or re-claim a prior attempt that never delivered. Only an
  // already-'sent' row is a true duplicate: `setWhere` skips it so a delivered
  // email is never re-sent, and the empty-returning case is handled below. A
  // 'queued'/'failed' row (a crash between send + status update, or a transient
  // Resend failure) is reset to 'queued' with its error cleared and re-sent —
  // collapsing it to 'duplicate' would permanently lose the email. This single
  // upsert replaces the old insert-then-select-then-conditional-update path.
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
    // Empty returning means the conflict hit an already-'sent' row that
    // `setWhere` skipped — a true duplicate. Look up its id to return it.
    const existing = await db()
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(
        and(eq(emailSends.userId, args.userId), eq(emailSends.idempotencyKey, args.idempotencyKey)),
      );
    const row = existing[0];
    if (!row) {
      // Race: someone deleted the conflicting row between our upsert and select.
      // Caller should treat this as a transient and retry.
      throw new Error("[notify] idempotency-key conflict but no row found on lookup");
    }
    return { status: "duplicate", emailSendId: row.id };
  }

  const resend = getResendClient();

  try {
    const result = await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: toAddress,
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: {
        "X-Alfred-Idempotency-Key": args.idempotencyKey,
        "X-Alfred-Kind": args.kind,
      },
    });
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
