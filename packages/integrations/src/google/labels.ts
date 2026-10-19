import { logger } from "@alfred/logging";
import {
  getPath,
  getStringPath,
  hasEveryKey,
  isHttpError,
  toStringArray,
  TRIAGE_CATEGORIES,
  typedEntries,
  type TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { eq, sql } from "drizzle-orm";
import { gmailMailbox, type GmailMailbox } from "./mailbox";

/**
 * Triage labels (ADR-0025 #1). Reuses the user's numbered labels ("2: action needed")
 * so they sort in the Gmail sidebar.
 */

export { TRIAGE_CATEGORIES, type TriageCategory };

const LABEL_NAMES = {
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
} satisfies Record<TriageCategory, string>;

export function labelNameFor(category: TriageCategory): string {
  return LABEL_NAMES[category];
}

const NAME_TO_CATEGORY = typedEntries(LABEL_NAMES).reduce<Record<string, TriageCategory>>(
  (acc, [cat, name]) => {
    acc[name] = cat;

    return acc;
  },
  {},
);

export interface AlfredLabelMap {
  byCategory: Record<TriageCategory, string>;
  allIds: string[];
}

/**
 * Ensure every triage label exists and return the id map, cached on
 * `metadata.alfredLabels`. A caller that sees a stale id (a 404) calls again with `force`.
 */
export async function ensureAlfredLabels(
  credentialId: string,
  opts: { force?: boolean } = {},
): Promise<AlfredLabelMap> {
  if (!opts.force) {
    const cached = await loadCachedLabels(credentialId);

    if (cached) return cached;
  }

  const mailbox = gmailMailbox({ credentialId });
  const existing = await mailbox.listLabels();
  const existingByName = new Map(existing.map((l) => [l.name, l.id] as const));

  const byCategory: Partial<Record<TriageCategory, string>> = {};

  for (const cat of TRIAGE_CATEGORIES) {
    const name = LABEL_NAMES[cat];
    let id = existingByName.get(name);

    if (!id) {
      // A parallel create returns 409; re-list to recover the id.
      try {
        const created = await mailbox.createLabel({ name });
        id = created.id;
      } catch (err) {
        const recovered = await findLabelByName(mailbox, name);

        if (recovered) {
          id = recovered;
        } else {
          throw err;
        }
      }
    }

    byCategory[cat] = id;
  }

  // The loop above sets every category or throws, so this cannot fail.
  if (!hasEveryKey(byCategory, TRIAGE_CATEGORIES)) {
    throw new Error("ensureAlfredLabels: a triage category has no label id");
  }

  const map: AlfredLabelMap = {
    byCategory,
    allIds: Object.values(byCategory),
  };

  await persistCachedLabels(credentialId, map);

  return map;
}

async function findLabelByName(
  mailbox: Pick<GmailMailbox, "listLabels">,
  name: string,
): Promise<string | undefined> {
  const all = await mailbox.listLabels();

  return all.find((l) => l.name === name)?.id;
}

async function loadCachedLabels(credentialId: string): Promise<AlfredLabelMap | null> {
  const rows = await db()
    .select({ metadata: integrationCredentials.metadata })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));

  const meta: unknown = rows[0]?.metadata;
  // A missing category (added since the cache was written) forces a refresh.
  const byCategory: Partial<Record<TriageCategory, string>> = {};

  for (const cat of TRIAGE_CATEGORIES) {
    const id = getStringPath(meta, "alfredLabels", "byCategory", cat);

    if (id) byCategory[cat] = id;
  }

  if (!hasEveryKey(byCategory, TRIAGE_CATEGORIES)) return null;

  const allIds = toStringArray(getPath(meta, "alfredLabels", "allIds"));

  return {
    byCategory,
    allIds: allIds.length > 0 ? allIds : Object.values(byCategory),
  };
}

async function persistCachedLabels(credentialId: string, map: AlfredLabelMap): Promise<void> {
  // jsonb_set keeps the other metadata keys (watch state).
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
 * Triage labels on the other messages of a thread. Gmail shows the union of
 * labels across a thread, so stale ones must be stripped.
 */
export async function findThreadSiblingsWithAlfredLabels(args: {
  credentialId: string;
  threadId: string;
  excludeMessageId: string;
}): Promise<Array<{ messageId: string; labelId: string }>> {
  const alfredLabels = await ensureAlfredLabels(args.credentialId);
  const alfredIds = new Set(alfredLabels.allIds);
  const mailbox = gmailMailbox({ credentialId: args.credentialId });
  const messages = await mailbox.getThreadMessageLabels({ threadId: args.threadId });
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
  /** A message id, not a thread id: labels apply per message. */
  messageId: string;
  category: TriageCategory;
  /** Stored on the `email_triage` row, so a swap needs no list call. */
  previousLabelId?: string | undefined;
  /** Strip every other triage label, for a message that may have been hand-labeled. */
  stripAllAlfredLabels?: boolean | undefined;
  /**
   * Thread messages whose triage label to strip.
   * The caller then clears their `email_triage.applied_label_id`.
   */
  threadSiblings?: ReadonlyArray<{ messageId: string; labelId: string }>;
}

export interface ApplyTriageLabelResult {
  appliedLabelId: string;
  removedLabelIds: string[];
  strippedSiblings: Array<{ messageId: string; labelId: string }>;
}

/**
 * Apply the category label and remove the previous one, so a message never has two.
 * The caller persists the returned id on `email_triage.applied_label_id`.
 */
export async function applyTriageLabel(
  args: ApplyTriageLabelArgs,
): Promise<ApplyTriageLabelResult> {
  const mailbox = gmailMailbox({ credentialId: args.credentialId });
  const labels = await ensureAlfredLabels(args.credentialId);
  const targetId = labels.byCategory[args.category];

  const removeLabelIds: string[] = [];

  if (args.stripAllAlfredLabels) {
    for (const id of labels.allIds) if (id !== targetId) removeLabelIds.push(id);
  } else if (args.previousLabelId && args.previousLabelId !== targetId) {
    removeLabelIds.push(args.previousLabelId);
  }

  await mailbox.modifyMessageLabels({
    messageId: args.messageId,
    addLabelIds: [targetId],
    removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
  });

  // One call per sibling: batchModify needs one label set for all messages.
  const strippedSiblings: Array<{ messageId: string; labelId: string }> = [];

  for (const sibling of args.threadSiblings ?? []) {
    if (sibling.messageId === args.messageId) continue;

    try {
      await mailbox.modifyMessageLabels({
        messageId: sibling.messageId,
        removeLabelIds: [sibling.labelId],
      });
      strippedSiblings.push(sibling);
    } catch (err) {
      // A deleted sibling must not block the new message's label.
      logger.warn(
        { err },
        `[triage:applyTriageLabel] failed to strip sibling label ` +
          `messageId=${sibling.messageId} labelId=${sibling.labelId}`,
      );
    }
  }

  return { appliedLabelId: targetId, removedLabelIds: removeLabelIds, strippedSiblings };
}

export function categoryFromLabelName(name: string): TriageCategory | undefined {
  return NAME_TO_CATEGORY[name];
}

// Self-mail label

/**
 * Label for Alfred's own mail (briefings, approval requests) that comes back as inbound.
 * Triage drops that mail (`isSelfAuthored`); this label only gathers it (#285).
 * Not in `AlfredLabelMap.allIds`: the relabel path must never strip or swap it.
 */
export const ALFRED_SELF_LABEL_NAME = "Alfred";

/** Same pattern as `ensureAlfredLabels`, cached on `metadata.alfredSelfLabel`. */
export async function ensureAlfredSelfLabel(
  credentialId: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (!opts.force) {
    const cached = await loadCachedSelfLabel(credentialId);

    if (cached) return cached;
  }

  const mailbox = gmailMailbox({ credentialId });
  let id = await findLabelByName(mailbox, ALFRED_SELF_LABEL_NAME);

  if (!id) {
    try {
      const created = await mailbox.createLabel({ name: ALFRED_SELF_LABEL_NAME });
      id = created.id;
    } catch (err) {
      const recovered = await findLabelByName(mailbox, ALFRED_SELF_LABEL_NAME);

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

  const meta: unknown = rows[0]?.metadata;

  return getStringPath(meta, "alfredSelfLabel", "id") ?? null;
}

async function persistCachedSelfLabel(credentialId: string, id: string): Promise<void> {
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

/** Test seam. */
export interface LabelSelfMailDeps {
  ensureLabel: (args: { credentialId: string; force?: boolean | undefined }) => Promise<string>;
  addLabel: (args: { credentialId: string; messageId: string; labelId: string }) => Promise<void>;
}

const defaultLabelSelfMailDeps: LabelSelfMailDeps = {
  ensureLabel: ({ credentialId, force }) =>
    ensureAlfredSelfLabel(credentialId, force !== undefined ? { force } : {}),
  addLabel: async ({ credentialId, messageId, labelId }) => {
    await gmailMailbox({ credentialId }).modifyMessageLabels({ messageId, addLabelIds: [labelId] });
  },
};

export interface LabelSelfAuthoredMailArgs {
  credentialId: string;
  messageId: string;
  /**
   * Skips the write when the label is already here. The 5-minute poll re-lists
   * self-mail every time, because it never becomes a `documents` row.
   */
  currentLabelIds?: readonly string[] | undefined;
}

/** On a 404 (label deleted), rebuild the label with `force` and retry once. */
export async function labelSelfAuthoredMail(
  args: LabelSelfAuthoredMailArgs,
  deps: LabelSelfMailDeps = defaultLabelSelfMailDeps,
): Promise<{ labeled: boolean; labelId: string }> {
  const { credentialId, messageId } = args;
  let labelId = await deps.ensureLabel({ credentialId });

  if (args.currentLabelIds?.includes(labelId)) {
    return { labeled: false, labelId };
  }

  try {
    await deps.addLabel({ credentialId, messageId, labelId });
  } catch (err) {
    if (!isHttpError(err) || err.status !== 404) throw err;
    labelId = await deps.ensureLabel({ credentialId, force: true });
    await deps.addLabel({ credentialId, messageId, labelId });
  }

  return { labeled: true, labelId };
}
