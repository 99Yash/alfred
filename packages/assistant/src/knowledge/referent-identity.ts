/**
 * Deterministic referent identities for the ADR-0067 projection (ADR-0092 S1).
 * A recurring notification is about a thing (an alarm, a task, a PR), and that
 * thing carries the dedup key, not the Gmail thread. Pure: subject, sender, and
 * threading headers only.
 *
 * Evidence, strongest first: GitHub threading headers
 * (`<owner/repo/pull/913@github.com>`), then the subject grammar in
 * {@link deriveLoopEntityRef}, which this module does not restate.
 * Both are gated on `trackerSenderKey`: a header is the sender's own claim.
 *
 * A global key (`github:pull_request:owner/repo#913`) stands alone. A
 * sender-scoped key (an alarm name) is unique only within its sender, so the
 * fold binds it via {@link senderScopedReferentIdentity}.
 *
 * Fold case only where the provider ignores case (`owner/repo`). Keep opaque ids
 * as they are: merging two objects is worse than repeating a todo.
 */

import {
  canonicalizeIdentityValue,
  deriveLoopEntityRef,
  identityRefSchema,
  integrationObjectKey,
  trackerSenderKey,
  type GmailEmailMessagePayload,
  type IdentityRef,
  type IntegrationObjectSegmentFor,
  type LoopEntityProvider,
  type LoopEntityRef,
} from "@alfred/contracts";

/** ADR-0062 `provider:kind:externalId`. No new identity kind. */
export const REFERENT_IDENTITY_KIND = "integration_object_key" as const;

/**
 * Referent segments only. `project` nodes share the identity kind, so a new shape
 * must register its segment before `classifyEntityKind` can tell them apart (U1).
 */
type ReferentSegment = IntegrationObjectSegmentFor<"referent">;

/** The one mint here. Only `referent` segments can pass. */
function referentValue(provider: string, segment: ReferentSegment, externalId: string): string {
  return integrationObjectKey(provider, segment, externalId);
}

/** The sender-scoped fallback key's provider and kind. */
const FALLBACK_PROVIDER = "alfred";

const FALLBACK_SEGMENT: ReferentSegment = "referent";

/** How the referent was found. Evidence only; no key depends on it. */
export type ReferentEvidence = "github_threading_header" | "loop_key_entity" | "loop_key_subject";

interface ReferentKeyBase {
  /** Profile label, derived from the key, never the raw subject. */
  readonly displayName: string;
  readonly evidence: ReferentEvidence;
}

/** A key that identifies the object alone, so it bridges sources. */
export interface GlobalReferentKey extends ReferentKeyBase {
  readonly scope: "global";
  readonly value: string;
}

/** Unique only within its sender. The fold adds the sender node id. */
export interface SenderScopedReferentKey extends ReferentKeyBase {
  readonly scope: "sender";
  /** Lowercased, whitespace-collapsed. */
  readonly name: string;
}

export type ReferentKey = GlobalReferentKey | SenderScopedReferentKey;

/**
 * The RFC 5322 threading headers, nested like the payload. The payload has two
 * `messageId` fields (Gmail id and RFC id); nesting makes passing the wrong one a build error.
 */
export type ReferentThreadingHeaders = Partial<
  Pick<GmailEmailMessagePayload["headers"], "messageId" | "inReplyTo" | "references">
>;

export interface ReferentKeyInput {
  readonly subject: string | null | undefined;
  /** `From` header or bare address. Both evidence classes gate on it. */
  readonly sender: string | null | undefined;
  /** `payload.headers`, passed whole. */
  readonly headers?: ReferentThreadingHeaders | null | undefined;
}

/**
 * The referent this email is about, or `null`. At most one key per message:
 * "ENG-123 blocked by #786" names two things, and merging them hides an incident.
 */
export function referentKeyForEmail(input: ReferentKeyInput): ReferentKey | null {
  // Gate both classes: anyone can forge `Message-ID: <owner/repo/pull/913@github.com>`.
  const tracker = trackerSenderKey(input.sender);

  if (tracker === "github") {
    const fromHeaders = githubReferentFromThreadingHeaders(input.headers);

    if (fromHeaders) return fromHeaders;
  }

  // A human quoting "[owner/repo] … (PR #1)" must not merge rail items.
  const loopRef = deriveLoopEntityRef(input.subject, {
    sender: input.sender,
    requireTrackerSender: true,
  });

  return loopRef ? referentKeyFromLoopEntityRef(loopRef) : null;
}

/** The `integration_object_key` identity for a global key. */
export function globalReferentIdentity(key: GlobalReferentKey): IdentityRef {
  return assertLegalReferentIdentity(key.value);
}

/** Scope by sender node id, not address, so the key survives another identity. Needs the fold. */
export function senderScopedReferentIdentity(
  key: SenderScopedReferentKey,
  senderEntityId: string,
): IdentityRef {
  const trimmed = senderEntityId.trim();

  if (trimmed.length === 0) {
    throw new Error(`[user-model.referent-identity] sender-scoped key needs a sender node id`);
  }

  return assertLegalReferentIdentity(
    referentValue(FALLBACK_PROVIDER, FALLBACK_SEGMENT, `${trimmed}/${key.name}`),
  );
}

// ─── GitHub threading headers ────────────────────────────────────────────────

const GITHUB_NOTIFICATION_HOST = "github.com";

const GITHUB_OWNER_REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const DIGITS_RE = /^\d+$/;

const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** GitHub GraphQL node id (`CS_kwDO…`). Opaque and case-significant. */
const GITHUB_NODE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Supported `owner/repo/<type>/<id>@github.com` shapes. Unlisted types (`push`,
 * `releases`) fall through: a wrong mint leaves a permanent node. `foldId` folds
 * only case-insensitive ids (ADR-0092 D3).
 */
const GITHUB_HEADER_OBJECT_REGISTRY: ReadonlyArray<{
  readonly objectType: string;
  readonly kind: ReferentSegment;
  readonly idPattern: RegExp;
  readonly foldId: (id: string) => string;
}> = [
  { objectType: "pull", kind: "pull_request", idPattern: DIGITS_RE, foldId: (id) => id },
  { objectType: "issues", kind: "issue", idPattern: DIGITS_RE, foldId: (id) => id },
  { objectType: "discussions", kind: "discussion", idPattern: DIGITS_RE, foldId: (id) => id },
  {
    objectType: "commit",
    kind: "commit",
    idPattern: COMMIT_SHA_RE,
    foldId: (id) => id.toLowerCase(),
  },
  {
    objectType: "check-suites",
    kind: "check_suite",
    idPattern: GITHUB_NODE_ID_RE,
    foldId: (id) => id, // opaque, case-significant
  },
];

/**
 * Prefer `In-Reply-To` / `References`: they name the thread root (the PR), while
 * `Message-ID` names this comment.
 */
function githubReferentFromThreadingHeaders(
  headers: ReferentThreadingHeaders | null | undefined,
): GlobalReferentKey | null {
  if (!headers) return null;
  const candidates = [headers.inReplyTo, ...(headers.references ?? []), headers.messageId];

  for (const candidate of candidates) {
    const key = githubReferentFromMessageId(candidate);

    if (key) return key;
  }

  return null;
}

function githubReferentFromMessageId(raw: string | null | undefined): GlobalReferentKey | null {
  if (!raw) return null;
  const parsed = parseGitHubMessageIdAddress(raw);

  if (!parsed) return null;

  const { owner, repo, objectType, objectId } = parsed;
  // GitHub ignores case in `owner/repo`; fold with the shared helper.
  const fullName = canonicalizeIdentityValue("github_repository_full_name", `${owner}/${repo}`);

  for (const entry of GITHUB_HEADER_OBJECT_REGISTRY) {
    if (entry.objectType !== objectType) continue;

    if (!entry.idPattern.test(objectId)) return null;
    const foldedId = entry.foldId(objectId);

    const id =
      entry.kind === "commit"
        ? `${fullName}@${foldedId}`
        : entry.kind === "check_suite"
          ? `${fullName}/${foldedId}`
          : `${fullName}#${foldedId}`;

    return githubKey(entry.kind, id, "github_threading_header");
  }

  return null;
}

/** Parse `<owner/repo/type/id@github.com>`. */
function parseGitHubMessageIdAddress(raw: string): {
  owner: string;
  repo: string;
  objectType: string;
  objectId: string;
} | null {
  const addr = stripAngleBrackets(raw.trim());
  const at = addr.lastIndexOf("@");

  if (at <= 0) return null;

  if (addr.slice(at + 1).toLowerCase() !== GITHUB_NOTIFICATION_HOST) return null;

  const segments = addr.slice(0, at).split("/");
  const [owner, repo, objectType, objectId] = segments;

  if (!owner || !repo || !objectType || !objectId) return null;

  if (!GITHUB_OWNER_REPO_SEGMENT_RE.test(owner) || !GITHUB_OWNER_REPO_SEGMENT_RE.test(repo)) {
    return null;
  }

  return { owner, repo, objectType, objectId };
}

function stripAngleBrackets(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1).trim();

  // Tolerate one missing bracket.
  return trimmed.replace(/^</, "").replace(/>$/, "").trim();
}

/**
 * Far below `MAX_IDENTITY_VALUE_BYTES`: the format ends in `.+`, so only the size
 * check would catch a runaway subject. Over budget, mint no key rather than an illegal one.
 */
const MAX_REFERENT_EXTERNAL_ID_BYTES = 256;

const UTF8_ENCODER = new TextEncoder();

function withinExternalIdBudget(externalId: string): boolean {
  return UTF8_ENCODER.encode(externalId).byteLength <= MAX_REFERENT_EXTERNAL_ID_BYTES;
}

function githubKey(
  kind: ReferentSegment,
  id: string,
  evidence: ReferentEvidence,
): GlobalReferentKey | null {
  if (!withinExternalIdBudget(id)) return null;

  return {
    scope: "global",
    value: referentValue("github", kind, id),
    displayName: id,
    evidence,
  };
}

// ─── Subject grammar (the shrinking floor) ───────────────────────────────────

/** `subject` and monitoring alarms are sender-scoped; the other kinds carry a provider-unique id. */
function referentKeyFromLoopEntityRef(ref: LoopEntityRef): ReferentKey | null {
  const trimmedId = ref.id.trim();

  if (trimmedId.length === 0) return null;

  // Fold before mint, so `Owner/Repo#786` and `owner/repo#786` do not split.
  const foldedId = trimmedId.toLowerCase();

  // Kind before provider: a GitHub `subject` key must not become a global `github:subject:…` key.
  switch (ref.kind) {
    case "subject":
    case "alarm":
      return senderScopedKey(foldedId);
    case "pull_request":
    case "issue": {
      if (ref.provider === "github") {
        return githubKey(ref.kind, foldedId, "loop_key_entity");
      }

      if (ref.kind === "issue") {
        return globalIssueKey(ref.provider, foldedId);
      }

      // A non-GitHub `pull_request` should not happen; scope it to the sender instead of a global key.
      return senderScopedKey(foldedId);
    }

    default: {
      // A new `LoopEntityKind` must stop the build: a wrong scope mints a permanent node.
      const _exhaustive: never = ref.kind;
      void _exhaustive;

      return senderScopedKey(foldedId);
    }
  }
}

function globalIssueKey(provider: LoopEntityProvider, foldedId: string): GlobalReferentKey | null {
  if (!withinExternalIdBudget(foldedId)) return null;

  return {
    scope: "global",
    value: referentValue(provider, "issue", foldedId),
    displayName: foldedId,
    evidence: "loop_key_entity",
  };
}

function senderScopedKey(foldedName: string): SenderScopedReferentKey | null {
  if (!withinExternalIdBudget(foldedName)) return null;

  return {
    scope: "sender",
    name: foldedName,
    displayName: foldedName,
    evidence: "loop_key_subject",
  };
}

// ─── Shape enforcement ───────────────────────────────────────────────────────

/**
 * Parse every value through `identityRefSchema`, so a bad value fails here and
 * not at `computeStableEntityId`. Throwing means a bug in this module.
 */
function assertLegalReferentIdentity(value: string): IdentityRef {
  const parsed = identityRefSchema.safeParse({ kind: REFERENT_IDENTITY_KIND, value });

  if (!parsed.success) {
    throw new Error(
      `[user-model.referent-identity] minted an illegal ${REFERENT_IDENTITY_KIND} value ` +
        `${JSON.stringify(value)}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  return parsed.data;
}
