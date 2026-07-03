import { TRIAGE_CATEGORIES, type TriageCategory, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { eq, sql } from "drizzle-orm";
import { getFreshAccessToken } from "./credentials";
import { createLabel, getThreadMessageLabels, listLabels, modifyMessageLabels } from "./gmail";

/**
 * Triage labels (ADR-0025 #1).
 *
 * Reuse the user's existing numbered priority labels (originally created by
 * Dimension and kept by the user). The numeric prefix gives a natural sort
 * order in the Gmail sidebar — `action_needed` is "2: action needed", `fyi`
 * is "6: fyi", etc. The category enum itself lives in `@alfred/contracts`
 * (browser-safe) so the web rail can render category chips without pulling
 * in this Node-only module; we just add the integration-specific label-name
 * mapping on top.
 */

export { TRIAGE_CATEGORIES, type TriageCategory };

const LABEL_NAMES: Record<TriageCategory, string> = {
  urgent: "1: urgent",
  action_needed: "2: action needed",
  follow_up: "3: follow up",
  awaiting_reply: "4: awaiting reply",
  meeting: "5: meeting",
  fyi: "6: fyi",
  done: "7: done",
  payment: "8: payment",
  newsletter: "9: newsletter",
  marketing: "10: marketing",
};

export function labelNameFor(category: TriageCategory): string {
  return LABEL_NAMES[category];
}

/** Reverse map of label name → category, for parsing existing Gmail state. */
const NAME_TO_CATEGORY = Object.entries(LABEL_NAMES).reduce<Record<string, TriageCategory>>(
  (acc, [cat, name]) => {
    acc[name] = cat as TriageCategory;
    return acc;
  },
  {},
);

export interface AlfredLabelMap {
  /** category → Gmail label id. */
  byCategory: Record<TriageCategory, string>;
  /** All alfred-owned label ids (handy for batch-remove during re-classification). */
  allIds: string[];
}

/**
 * Ensure every Alfred/* label exists in the user's mailbox and return the
 * id map. The result is cached on `integrationCredentials.metadata.alfredLabels`;
 * subsequent calls hit the cache unless `force = true`.
 *
 * Idempotent: if a label already exists, we reuse the id; if it was deleted
 * out-of-band, we re-create it. The cache invalidates lazily — callers that
 * detect a stale id (e.g. modify returns 404 on the label) re-call with
 * `force` to rebuild.
 */
export async function ensureAlfredLabels(
  credentialId: string,
  opts: { force?: boolean; accessToken?: string } = {},
): Promise<AlfredLabelMap> {
  if (!opts.force) {
    const cached = await loadCachedLabels(credentialId);
    if (cached) return cached;
  }

  // Reuse a caller-supplied token when present — otherwise a sibling call
  // chain that already fetched one ends up triggering a second DB read and,
  // near expiry, a concurrent refresh.
  const accessToken = opts.accessToken ?? (await getFreshAccessToken(credentialId));
  const existing = await listLabels({ accessToken });
  const existingByName = new Map(existing.map((l) => [l.name, l.id] as const));

  const byCategory = {} as Record<TriageCategory, string>;
  for (const cat of TRIAGE_CATEGORIES) {
    const name = LABEL_NAMES[cat];
    let id = existingByName.get(name);
    if (!id) {
      // Race-safe: if a parallel call already created this label, the API
      // returns 409. We catch and re-list rather than synchronizing across
      // workers — at single-user scale collisions are rare and recovery is
      // a single GET.
      try {
        const created = await createLabel({ accessToken, name });
        id = created.id;
      } catch (err) {
        const recovered = await findLabelByName(accessToken, name);
        if (recovered) {
          id = recovered;
        } else {
          throw err;
        }
      }
    }
    byCategory[cat] = id;
  }

  const map: AlfredLabelMap = {
    byCategory,
    allIds: Object.values(byCategory),
  };
  await persistCachedLabels(credentialId, map);
  return map;
}

async function findLabelByName(accessToken: string, name: string): Promise<string | undefined> {
  const all = await listLabels({ accessToken });
  return all.find((l) => l.name === name)?.id;
}

interface CredentialMetadataShape {
  alfredLabels?: {
    byCategory?: Partial<Record<TriageCategory, string>>;
    allIds?: string[];
    cachedAt?: string;
  };
  alfredSelfLabel?: {
    id?: string;
    name?: string;
    cachedAt?: string;
  };
  [key: string]: unknown;
}

async function loadCachedLabels(credentialId: string): Promise<AlfredLabelMap | null> {
  const rows = await db()
    .select({ metadata: integrationCredentials.metadata })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const meta = (rows[0]?.metadata as CredentialMetadataShape | null) ?? {};
  const cached = meta.alfredLabels;
  if (!cached?.byCategory) return null;
  // Validate the cache covers every category — if a new category was added
  // since the cache was written, force a refresh.
  const byCategory = {} as Record<TriageCategory, string>;
  for (const cat of TRIAGE_CATEGORIES) {
    const id = cached.byCategory[cat];
    if (!id) return null;
    byCategory[cat] = id;
  }
  return {
    byCategory,
    allIds: cached.allIds ?? Object.values(byCategory),
  };
}

async function persistCachedLabels(credentialId: string, map: AlfredLabelMap): Promise<void> {
  // Merge into existing metadata via jsonb_set so we don't clobber unrelated
  // keys (e.g. watch-channel state stored alongside).
  const value = JSON.stringify({
    byCategory: map.byCategory,
    allIds: map.allIds,
    cachedAt: new Date().toISOString(),
  });
  await db()
    .update(integrationCredentials)
    .set({
      metadata: sql`jsonb_set(coalesce(${integrationCredentials.metadata}, '{}'::jsonb), '{alfredLabels}', ${value}::jsonb, true)`,
    })
    .where(eq(integrationCredentials.id, credentialId));
}

/**
 * Inspect every message in a Gmail thread and return the alfred-owned labels
 * found on siblings (messages other than `excludeMessageId`). Used by the
 * triage workflow to strip stale labels from older messages so the thread
 * view in Gmail collapses to a single tag — Gmail's UI unions labels across
 * every message in a thread.
 *
 * One thread.get call (minimal format) + one label-map lookup. No DB hits
 * beyond the credential cache used by `ensureAlfredLabels`.
 */
export async function findThreadSiblingsWithAlfredLabels(args: {
  credentialId: string;
  threadId: string;
  excludeMessageId: string;
}): Promise<Array<{ messageId: string; labelId: string }>> {
  const accessToken = await getFreshAccessToken(args.credentialId);
  const alfredLabels = await ensureAlfredLabels(args.credentialId, { accessToken });
  const alfredIds = new Set(alfredLabels.allIds);
  const messages = await getThreadMessageLabels({ accessToken, threadId: args.threadId });
  const siblings: Array<{ messageId: string; labelId: string }> = [];
  for (const m of messages) {
    if (m.id === args.excludeMessageId) continue;
    for (const labelId of m.labelIds) {
      if (alfredIds.has(labelId)) {
        siblings.push({ messageId: m.id, labelId });
      }
    }
  }
  return siblings;
}

export interface ApplyTriageLabelArgs {
  credentialId: string;
  /** Gmail message id (NOT thread id — labels apply per-message). */
  messageId: string;
  category: TriageCategory;
  /**
   * Previously-applied alfred-label id to remove, if any. Stored on the
   * `email_triage` row so re-classification swaps cleanly without a list
   * round-trip.
   */
  previousLabelId?: string;
  /**
   * When true, also strip every other Alfred/* label off the message — used
   * the first time we touch a message that may have been hand-labelled to a
   * different alfred category. Defaults to false (cheaper, common case).
   */
  stripAllAlfredLabels?: boolean;
  /**
   * Other Gmail messages in the same thread that currently hold an alfred
   * label. We strip each one's label so the thread view collapses to a single
   * alfred tag (Gmail unions labels across messages in a thread). Caller is
   * responsible for clearing the corresponding `email_triage.applied_label_id`
   * rows after this returns.
   */
  threadSiblings?: ReadonlyArray<{ messageId: string; labelId: string }>;
}

export interface ApplyTriageLabelResult {
  appliedLabelId: string;
  removedLabelIds: string[];
  /** Sibling messages whose alfred label was stripped (mirrors `threadSiblings`). */
  strippedSiblings: Array<{ messageId: string; labelId: string }>;
}

/**
 * Write the chosen alfred-label to a Gmail message and return the id that
 * landed (the caller persists it on `email_triage.applied_label_id`).
 *
 * Removes the previously-applied alfred-label first so a re-classification
 * doesn't leave the message tagged with two contradictory categories. When
 * `threadSiblings` is supplied, also strips each sibling's alfred label so
 * the thread view in Gmail collapses to a single tag — without this, replies
 * stack their new label on top of older messages' stale labels.
 */
export async function applyTriageLabel(
  args: ApplyTriageLabelArgs,
): Promise<ApplyTriageLabelResult> {
  const accessToken = await getFreshAccessToken(args.credentialId);
  const labels = await ensureAlfredLabels(args.credentialId, { accessToken });
  const targetId = labels.byCategory[args.category];

  const removeLabelIds: string[] = [];
  if (args.stripAllAlfredLabels) {
    for (const id of labels.allIds) if (id !== targetId) removeLabelIds.push(id);
  } else if (args.previousLabelId && args.previousLabelId !== targetId) {
    removeLabelIds.push(args.previousLabelId);
  }

  await modifyMessageLabels({
    accessToken,
    messageId: args.messageId,
    addLabelIds: [targetId],
    removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
  });

  // Strip sibling labels one-by-one. Gmail's batchModify takes a single
  // add/remove set across N messages, which only helps when every sibling
  // carries the same label — at single-user scale (typically <10 messages
  // per thread, often 1) the serial round-trips are cheaper than the
  // grouping logic.
  const strippedSiblings: Array<{ messageId: string; labelId: string }> = [];
  for (const sibling of args.threadSiblings ?? []) {
    if (sibling.messageId === args.messageId) continue;
    try {
      await modifyMessageLabels({
        accessToken,
        messageId: sibling.messageId,
        removeLabelIds: [sibling.labelId],
      });
      strippedSiblings.push(sibling);
    } catch (err) {
      // A sibling message could have been deleted out of band. Log and
      // continue — failing the whole label-write because one sibling went
      // missing would block the just-arrived message from getting tagged.
      console.warn(
        `[triage:applyTriageLabel] failed to strip sibling label ` +
          `messageId=${sibling.messageId} labelId=${sibling.labelId}: ` +
          toMessage(err),
      );
    }
  }

  return { appliedLabelId: targetId, removedLabelIds: removeLabelIds, strippedSiblings };
}

/** Map Gmail label name back to a TriageCategory, or undefined if unrelated. */
export function categoryFromLabelName(name: string): TriageCategory | undefined {
  return NAME_TO_CATEGORY[name];
}

// ---------------------------------------------------------------------------
// Self-mail label (issue #285)
// ---------------------------------------------------------------------------

/**
 * Dedicated Gmail label for Alfred's OWN outbound mail — the daily briefing and
 * HIL-approval requests. These ship through Resend (`notify.ts`), re-enter the
 * connected inbox as ordinary *inbound* mail, and are dropped from triage before
 * they become a `documents` row (`isSelfAuthored`, #211/#266) so they never
 * clutter the demanding lanes or feed the next briefing. Dropping them left them
 * unorganised, though — this label gathers that stream into one place the user
 * can find (#285) WITHOUT reopening the self-loop: the label is applied on the
 * same drop path, the message is still never triaged, embedded, or cached as a
 * sender prior.
 *
 * A flat, un-prefixed name keeps it distinct from the numbered triage priority
 * labels (`1: urgent` … `10: marketing`) and out of that ordered run in the
 * sidebar. Deliberately NOT part of `AlfredLabelMap.allIds` — that set is the
 * triage category labels the relabel path strips/swaps between, and self-mail is
 * never triaged, so the two must not intersect.
 */
export const ALFRED_SELF_LABEL_NAME = "Alfred";

/**
 * Ensure the dedicated self-mail label exists and return its id, cached on
 * `integrationCredentials.metadata.alfredSelfLabel`. Mirrors `ensureAlfredLabels`:
 * cache-first, race-safe create (recover the id on a 409), and re-creatable if the
 * user deleted it out of band (call with `force` to rebuild a stale cache).
 */
export async function ensureAlfredSelfLabel(
  credentialId: string,
  opts: { force?: boolean; accessToken?: string } = {},
): Promise<string> {
  if (!opts.force) {
    const cached = await loadCachedSelfLabel(credentialId);
    if (cached) return cached;
  }

  const accessToken = opts.accessToken ?? (await getFreshAccessToken(credentialId));
  let id = await findLabelByName(accessToken, ALFRED_SELF_LABEL_NAME);
  if (!id) {
    try {
      const created = await createLabel({ accessToken, name: ALFRED_SELF_LABEL_NAME });
      id = created.id;
    } catch (err) {
      const recovered = await findLabelByName(accessToken, ALFRED_SELF_LABEL_NAME);
      if (recovered) {
        id = recovered;
      } else {
        throw err;
      }
    }
  }

  await persistCachedSelfLabel(credentialId, id);
  return id;
}

async function loadCachedSelfLabel(credentialId: string): Promise<string | null> {
  const rows = await db()
    .select({ metadata: integrationCredentials.metadata })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const meta = (rows[0]?.metadata as CredentialMetadataShape | null) ?? {};
  return meta.alfredSelfLabel?.id ?? null;
}

async function persistCachedSelfLabel(credentialId: string, id: string): Promise<void> {
  // jsonb_set the single key so we don't clobber `alfredLabels` / watch state
  // stored in the same metadata blob.
  const value = JSON.stringify({
    id,
    name: ALFRED_SELF_LABEL_NAME,
    cachedAt: new Date().toISOString(),
  });
  await db()
    .update(integrationCredentials)
    .set({
      metadata: sql`jsonb_set(coalesce(${integrationCredentials.metadata}, '{}'::jsonb), '{alfredSelfLabel}', ${value}::jsonb, true)`,
    })
    .where(eq(integrationCredentials.id, credentialId));
}

/**
 * Injectable Gmail collaborators for `labelSelfAuthoredMail`. Defaults hit the
 * real API; tests supply fakes (same DI seam as `reconcileThreadLabel`) so the
 * skip / retry logic is exercised without a live mailbox.
 */
export interface LabelSelfMailDeps {
  ensureLabel: (args: {
    credentialId: string;
    accessToken: string;
    force?: boolean;
  }) => Promise<string>;
  addLabel: (args: { accessToken: string; messageId: string; labelId: string }) => Promise<void>;
}

const defaultLabelSelfMailDeps: LabelSelfMailDeps = {
  ensureLabel: ({ credentialId, accessToken, force }) =>
    ensureAlfredSelfLabel(credentialId, { accessToken, force }),
  addLabel: async ({ accessToken, messageId, labelId }) => {
    await modifyMessageLabels({ accessToken, messageId, addLabelIds: [labelId] });
  },
};

export interface LabelSelfAuthoredMailArgs {
  credentialId: string;
  /** Gmail message id of the self-authored message (labels apply per-message). */
  messageId: string;
  accessToken: string;
  /**
   * The message's current Gmail `labelIds`. When the self-label is already
   * present we skip the modify round-trip — the realtime poll re-lists self-mail
   * on every 5-min window (it never becomes a `documents` row, so the known-id
   * pre-filter can't drop it), and this guard keeps that churn off Gmail.
   */
  currentLabelIds?: readonly string[];
}

/**
 * Apply the dedicated Alfred self-mail label to one self-authored message (#285).
 *
 * Idempotent and self-healing: skips the write when the label is already on the
 * message, and if the cached label id is stale (the user deleted the label → the
 * modify 404s) it rebuilds the label with `force` and retries once. Returns
 * whether a write actually landed plus the resolved label id.
 */
export async function labelSelfAuthoredMail(
  args: LabelSelfAuthoredMailArgs,
  deps: LabelSelfMailDeps = defaultLabelSelfMailDeps,
): Promise<{ labeled: boolean; labelId: string }> {
  const { credentialId, messageId, accessToken } = args;
  let labelId = await deps.ensureLabel({ credentialId, accessToken });

  if (args.currentLabelIds?.includes(labelId)) {
    return { labeled: false, labelId };
  }

  try {
    await deps.addLabel({ accessToken, messageId, labelId });
  } catch {
    // The cached id may be stale (label deleted out of band). Rebuild from the
    // live label list and retry once; a second failure bubbles to the caller,
    // which treats self-mail labelling as best-effort.
    labelId = await deps.ensureLabel({ credentialId, accessToken, force: true });
    await deps.addLabel({ accessToken, messageId, labelId });
  }

  return { labeled: true, labelId };
}
