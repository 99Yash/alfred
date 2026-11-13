import {
  assertNever,
  emailDomain,
  escapeHtml,
  parseEmailAddress,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { logger } from "@alfred/logging";
import { report } from "@alfred/logging/report";
import { resolveSelfIdentity, userIdentity } from "@alfred/assistant/settings";
import type { AttachmentData, GetReceivingEmailResponseSuccess } from "resend";
import { z } from "zod";
import { selectEmailableUsers } from "./emailable-users";
import { notify, type ComposedEmail } from "./notify";
import { getResendClient } from "./resend-client";

/**
 * Result of one `POST /webhooks/resend` delivery. The route maps it to a status.
 * - `not_configured`: `RESEND_WEBHOOK_SECRET` is unset, 503.
 * - `rejected`: a Svix header is missing or the signature is bad, 400.
 * - `ignored`: verified, but Alfred does not forward it. 200, so Resend does not retry.
 * - `forwarded` and `duplicate`: the `email_sends` row for this mail is `sent`. 200.
 * - `failed`: a Resend read or the send failed, 500, so Resend retries.
 */
export type ResendWebhookOutcome =
  | { kind: "not_configured" }
  | { kind: "rejected"; reason: "missing_headers" | "invalid_signature" }
  | { kind: "ignored"; reason: string }
  | { kind: "forwarded"; emailSendId: string }
  | { kind: "duplicate"; emailSendId: string }
  | { kind: "failed"; error: string };

/** The fields Alfred reads from an `email.received` event. The event holds metadata only. */
const emailReceivedEventSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string(),
    received_for: z.array(z.string()),
  }),
});

/** The largest page that Resend's list endpoints accept. */
const ATTACHMENT_PAGE_LIMIT = 100;

export interface ReceiveResendWebhookArgs {
  /** Exact request bytes. Svix signs these, so a parse and re-stringify breaks the check. */
  raw: string;
  headers: Headers;
}

/**
 * Forward each mail that Resend Receiving gets for the Alfred domain to the owner's account
 * email. This is plumbing, not ingest: the mail does not reach triage or the corpus. The
 * `email_sends` row keyed `inbound_forward:{email id}` dedups Resend's retries, and `notify`
 * sends that key to Resend as the `Idempotency-Key`.
 */
export async function receiveResendWebhook(
  args: ReceiveResendWebhookArgs,
): Promise<ResendWebhookOutcome> {
  const webhookSecret = serverEnv().RESEND_WEBHOOK_SECRET;

  if (!webhookSecret) return { kind: "not_configured" };

  const id = args.headers.get("svix-id");
  const timestamp = args.headers.get("svix-timestamp");
  const signature = args.headers.get("svix-signature");

  if (!id || !timestamp || !signature) return { kind: "rejected", reason: "missing_headers" };

  let verified: unknown;

  try {
    verified = getResendClient().webhooks.verify({
      payload: args.raw,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
  } catch {
    logger.warn("[resend-webhook] signature verification failed");

    return { kind: "rejected", reason: "invalid_signature" };
  }

  const event = emailReceivedEventSchema.safeParse(verified);

  if (!event.success) return { kind: "ignored", reason: "not-email-received" };

  return forwardReceivedEmail(event.data.data);
}

async function forwardReceivedEmail(
  received: z.infer<typeof emailReceivedEventSchema>["data"],
): Promise<ResendWebhookOutcome> {
  // Loop guard: a mail from Alfred's own sender is a forward or a briefing that came back.
  const sender = parseEmailAddress(received.from);

  if (sender !== null && sender === resolveSelfIdentity().sendAddress) {
    return { kind: "ignored", reason: "self-sent" };
  }

  const owners = await selectEmailableUsers();
  const owner = owners.length === 1 ? owners[0] : undefined;

  if (!owner) {
    // More than one user must not get the domain's mail. None means no sign-in yet.
    report({
      event: "resend_webhook.no_single_owner",
      message: "a received mail was not forwarded because there is not exactly one emailable user",
      level: "error",
      tags: { owners: String(owners.length) },
      dimensions: [],
    });

    return { kind: "ignored", reason: "no-single-owner" };
  }

  const toAddress = (await userIdentity({ userId: owner.id })).primaryEmail;
  const ownerDomain = emailDomain(toAddress);

  // Loop guard: a forward to an address on a receiving domain comes back to this route.
  if (ownerDomain !== null && received.received_for.some((r) => emailDomain(r) === ownerDomain)) {
    report({
      event: "resend_webhook.owner_on_receiving_domain",
      message:
        "a received mail was not forwarded because the owner's address is on the receiving domain",
      level: "error",
      tags: { domain: ownerDomain },
      dimensions: [],
    });

    return { kind: "ignored", reason: "owner-on-receiving-domain" };
  }

  try {
    return await sendForward(received.email_id, owner.id, toAddress);
  } catch (error) {
    return { kind: "failed", error: toMessage(error) };
  }
}

async function sendForward(
  emailId: string,
  userId: string,
  toAddress: string,
): Promise<ResendWebhookOutcome> {
  const resend = getResendClient();
  // `cid` keeps inline images as `cid:` references, which the inline attachments below resolve.
  const fetched = await resend.emails.receiving.get(emailId, { html_format: "cid" });

  if (fetched.error) throw new Error(`receiving.get: ${fetched.error.message}`);
  const email = fetched.data;
  const attachments = await listAttachments(emailId);

  const result = await notify({
    userId,
    kind: "inbound_forward",
    idempotencyKey: `inbound_forward:${email.id}`,
    toAddress,
    ...composeForward(email),
    replyTo: email.reply_to?.length ? email.reply_to : [email.from],
    attachments: attachments.map((a, index) => ({
      filename: a.filename ?? `attachment-${index + 1}`,
      path: a.download_url,
      contentType: a.content_type,
      ...(a.content_disposition === "inline" && a.content_id ? { contentId: a.content_id } : {}),
    })),
    payload: { resendEmailId: email.id, from: email.from, to: email.to },
  });

  switch (result.status) {
    case "sent":
      return { kind: "forwarded", emailSendId: result.emailSendId };
    case "duplicate":
      return { kind: "duplicate", emailSendId: result.emailSendId };
    case "failed":
      return { kind: "failed", error: result.error };
    default:
      return assertNever(result, "notify result status");
  }
}

/** Every page. Throws on a Resend error, so the route answers 500 and Resend retries. */
async function listAttachments(emailId: string): Promise<AttachmentData[]> {
  const resend = getResendClient();
  const all: AttachmentData[] = [];
  let after: string | undefined;

  for (;;) {
    const page = await resend.emails.receiving.attachments.list({
      emailId,
      limit: ATTACHMENT_PAGE_LIMIT,
      ...(after ? { after } : {}),
    });

    if (page.error) throw new Error(`receiving.attachments.list: ${page.error.message}`);
    all.push(...page.data.data);
    const last = page.data.data.at(-1);

    if (!page.data.has_more || !last) return all;
    after = last.id;
  }
}

/** The original subject stays, so a reply in Gmail reads "Re: <subject>" to the sender. */
function composeForward(email: GetReceivingEmailResponseSuccess): ComposedEmail {
  const subject = email.subject || "(no subject)";

  const date =
    Object.entries(email.headers ?? {}).find(([name]) => name.toLowerCase() === "date")?.[1] ??
    email.created_at;

  const fields: Array<[string, string]> = [
    ["From", email.from],
    ["To", email.to.join(", ")],
  ];

  if (email.cc?.length) fields.push(["Cc", email.cc.join(", ")]);
  fields.push(["Date", date], ["Subject", subject]);

  const banner = "---------- Forwarded message ---------";

  const text = [
    banner,
    ...fields.map(([name, value]) => `${name}: ${value}`),
    "",
    email.text ?? "(The message has no plain-text part. Open the HTML part.)",
  ].join("\n");

  const header = [banner, ...fields.map(([name, value]) => `${name}: ${escapeHtml(value)}`)].join(
    "<br>",
  );

  const body =
    email.html ?? `<pre style="white-space:pre-wrap">${escapeHtml(email.text ?? "")}</pre>`;

  return { subject, text, html: `<div>${header}</div><br>${body}` };
}
