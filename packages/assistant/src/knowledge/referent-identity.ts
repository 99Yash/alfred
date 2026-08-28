/**
 * Deterministic REFERENT identities for the ADR-0067 projection (ADR-0092 S1).
 *
 * A recurring notification is about a real-world thing — a CloudWatch alarm, a
 * tracker task, a PR and its CI run — and that thing, not the Gmail thread, is
 * what must carry the dedup key. This module turns one `email_message`
 * observation payload into the identity of that thing, so the fold can mint a
 * `referent` node for it. Pure and deterministic: subject, sender, and the
 * threading headers the reducer already persists. No network, no model, no body.
 *
 * Two evidence classes, in strength order.
 *
 *   1. **Threading headers.** A GitHub notification addresses the object in its
 *      own `Message-ID` / `In-Reply-To` / `References`:
 *      `<owner/repo/pull/913@github.com>`. That is a hard, vendor-issued key —
 *      strictly better than reading the subject, because it survives a renamed
 *      title, a locale-prefixed `Re:`, and a truncated subject line.
 *   2. **Subject grammar.** Everything else falls through to
 *      {@link deriveLoopEntityRef}, the interim per-vendor table in
 *      `@alfred/contracts`. This module deliberately does NOT restate those
 *      regexes: one grammar, one owner. As header/API coverage grows, a vendor
 *      branch is deleted there and this module keeps working — that deletion is
 *      the debt clock ADR-0092 D5 opens.
 *
 * Two identity SCOPES come out, and the difference is whether the key is unique
 * on its own:
 *
 *   - **global** — `github:pull_request:owner/repo#913`. The id identifies the
 *     object across every source that mentions it, so a GitHub email, a Linear
 *     email, and (later) a webhook converge on one node with no coordination.
 *   - **sender-scoped** — an alarm name or a repeated task title is unique only
 *     within the service that sends it. `baserow-response-time` from SNS and the
 *     same words typed by a human are different things. The caller binds these
 *     to the projected sender node via {@link senderScopedReferentIdentity},
 *     because only the fold knows that node's id.
 *
 * Both classes are gated on the SAME sender test, `trackerSenderKey`. A
 * threading header is written by the sender, so it is evidence about an object
 * only when the sender is the vendor that issues those ids; without the gate,
 * any message could name — and permanently claim — any PR.
 *
 * Values are minted in the legal `integration_object_key` shape —
 * `provider:kind:externalId` (`IDENTITY_VALUE_FORMATS`) — with the `kind`
 * segment drawn from the shared `INTEGRATION_OBJECT_KIND_SEGMENTS` table,
 * because `project` nodes use the same identity kind and only the segment says
 * which node kind a value belongs to. Values are parsed through
 * `identityRefSchema` here rather than only in a test, because a malformed
 * value is otherwise rejected far away from this file. Case handling follows
 * the rule `canonicalizeIdentityValue` applies one level up: fold the segments that are case-INSENSITIVE at the
 * provider (`owner/repo`, an issue key, a normalized subject) and preserve the
 * ones that are case-SIGNIFICANT (an opaque GitHub node id). Blanket-lowercasing
 * an opaque provider id would merge two distinct objects, which is the failure
 * that matters here; under-merging only repeats a todo.
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

/**
 * Every referent identity is an `integration_object_key` — the ADR-0062
 * `provider:kind:externalId` shape, already the declared anchor for non-person
 * nodes. No new identity kind is introduced.
 */
export const REFERENT_IDENTITY_KIND = "integration_object_key" as const;

/**
 * The kind SEGMENT of every value this module mints. Drawn from the shared
 * `INTEGRATION_OBJECT_KIND_SEGMENTS` table, narrowed to the segments that anchor
 * a `referent` node, because the identity KIND alone does not say which node
 * kind a value belongs to — `project` nodes use the same kind. Typing the
 * segment here is what forces a new object shape to register in that table
 * before it can be minted, so `classifyEntityKind` can never read it as a
 * project (U1).
 */
type ReferentSegment = IntegrationObjectSegmentFor<"referent">;

/**
 * The ONE mint in this module. Narrows the shared builder to a `referent`
 * segment, so no path here can emit a value that `classifyEntityKind` would read
 * as another node kind.
 */
function referentValue(provider: string, segment: ReferentSegment, externalId: string): string {
  return integrationObjectKey(provider, segment, externalId);
}

/** Provider/kind segments of the sender-scoped fallback key. */
const FALLBACK_PROVIDER = "alfred";
const FALLBACK_SEGMENT: ReferentSegment = "referent";

/** How the referent was recognized. Evidence only — never switched on for a key. */
export type ReferentEvidence = "github_threading_header" | "loop_key_entity" | "loop_key_subject";

interface ReferentKeyBase {
  /** Stable label for the node's profile row. Derived from the key, never the raw subject. */
  readonly displayName: string;
  readonly evidence: ReferentEvidence;
}

/**
 * A referent key whose id identifies the object on its own, so it bridges
 * sources without any shared context.
 */
export interface GlobalReferentKey extends ReferentKeyBase {
  readonly scope: "global";
  /** Complete, legal `integration_object_key` value. */
  readonly value: string;
}

/**
 * A referent key that is unique only within the sender that emitted it. The
 * fold completes it with the projected sender node id.
 */
export interface SenderScopedReferentKey extends ReferentKeyBase {
  readonly scope: "sender";
  /** Canonical name, already lowercased and whitespace-collapsed. */
  readonly name: string;
}

export type ReferentKey = GlobalReferentKey | SenderScopedReferentKey;

/**
 * The RFC 5322 threading headers, DERIVED from the observation payload rather
 * than restated, and kept at the same path (`headers`) and the same names the
 * payload uses — so a caller passes `payload.headers` whole.
 *
 * Nested, not flattened, for one reason. `GmailEmailMessagePayload` has TWO
 * fields named `messageId`: the Gmail message id at the top level and the RFC
 * threading id under `headers`. Only the second is evidence about a referent. A
 * flat `messageId` on this input accepts the wrong one silently — it compiles,
 * it type-checks, and it disables the whole header evidence class. Under
 * `headers` the wrong field is not assignable, so the mistake is a build error.
 */
export type ReferentThreadingHeaders = Partial<
  Pick<GmailEmailMessagePayload["headers"], "messageId" | "inReplyTo" | "references">
>;

export interface ReferentKeyInput {
  readonly subject: string | null | undefined;
  /** `From` header or bare address — the sender evidence both classes gate on. */
  readonly sender: string | null | undefined;
  /** `payload.headers` from the `email_message` observation, passed whole. */
  readonly headers?: ReferentThreadingHeaders | null | undefined;
}

/**
 * Resolve the referent this email is about, or `null` when it is about a person
 * or carries no durable object. At most ONE key per message by design: two keys
 * found in one subject ("ENG-123 blocked by failing check on #786") name two
 * different things, and collapsing them would over-merge — the failure mode that
 * hides an incident. A node accumulates further identities from LATER evidence
 * that already shares one of its keys, never from a single ambiguous message.
 */
export function referentKeyForEmail(input: ReferentKeyInput): ReferentKey | null {
  // BOTH evidence classes gate on the SAME sender test, and the header class
  // needs it at least as much as the subject class does. `Message-ID`,
  // `In-Reply-To`, and `References` are written by whoever sent the mail: anyone
  // can set `Message-ID: <99Yash/alfred/pull/913@github.com>` and, ungated,
  // claim the permanent node for that PR. Because headers are the STRONGER
  // class and run first, gating only the subject class would leave the gate
  // dead. `trackerSenderKey` is the one owner of this question — the pattern
  // table is not restated here.
  const tracker = trackerSenderKey(input.sender);

  if (tracker === "github") {
    const fromHeaders = githubReferentFromThreadingHeaders(input.headers);
    if (fromHeaders) return fromHeaders;
  }

  // Todo dedup semantics: a hard persisted key needs sender evidence, or a human
  // quoting "[owner/repo] … (PR #1)" would merge unrelated rail items.
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

/**
 * Bind a sender-scoped key to the projected sender node. Scoping by NODE id
 * rather than by the raw address is what makes the key survive an address the
 * user also reaches under another identity, and it is why this step cannot live
 * in the pure extractor.
 */
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

/**
 * GitHub message ids that name an object we can key on. `push`, `releases`, and
 * anything unlisted are skipped rather than guessed: a wrong mint leaves a
 * permanent `entity_nodes` row that no replay removes, so an unrecognized shape
 * must fall through, not improvise.
 */
const GITHUB_NOTIFICATION_HOST = "github.com";
const GITHUB_OWNER_REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const DIGITS_RE = /^\d+$/;
const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,40}$/;
/** GitHub GraphQL node id (`CS_kwDO…`) — opaque and CASE-SIGNIFICANT. */
const GITHUB_NODE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Registry of GitHub header object shapes. One entry per supported
 * `owner/repo/<type>/<id>@github.com` variant — the table is the only place
 * that changes when the next GitHub object (e.g. `releases`) gains coverage.
 * `foldId` controls case handling per spec: case-insensitive segments are
 * folded, opaque ids are preserved verbatim (ADR-0092 D3).
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
    foldId: (id) => id, // opaque, case-significant — preserve verbatim
  },
];

/**
 * Read the referent out of the threading headers. `In-Reply-To` / `References`
 * are preferred over `Message-ID` because they address the thread ROOT — the PR
 * itself — while `Message-ID` addresses this particular comment. Both parse to
 * the same key today, but the preference is what keeps that true if GitHub ever
 * makes a comment id its own object.
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
  // `owner/repo` is case-insensitive at GitHub — fold via canonical helper so
  // the mint and the dedup share one normalization rule.
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

/** Parse `<owner/repo/type/id@github.com>` without exposing the raw string walk to callers. */
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
  // Tolerate a single leading `<` or trailing `>` when the peer bracket was
  // stripped upstream — keep the old two-replace behaviour as fallback.
  return trimmed.replace(/^</, "").replace(/>$/, "").trim();
}

/**
 * Byte budget for the `externalId` segment of a referent key. Deliberately far
 * below `MAX_IDENTITY_VALUE_BYTES`, and for a stronger reason than the size
 * limit: the `integration_object_key` FORMAT ends in `.+`, so an unbounded
 * subject line or an unbounded opaque header id clears the format and fails
 * only on the size refine, far from this file. A name that long also dedups
 * nothing — it is a runaway subject, not the name of a thing that recurs. Over
 * the budget the module mints NO key rather than an illegal one, which is the
 * safe direction: an under-merge repeats a todo, an over-merge hides an
 * incident.
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

/**
 * Map the interim loop ref onto a referent key. `kind: "subject"` and the
 * monitoring alarm are sender-scoped: a normalized subject and an alarm name are
 * unique within a service, not across the world. Everything else already carries
 * a provider-unique id.
 */
function referentKeyFromLoopEntityRef(ref: LoopEntityRef): ReferentKey | null {
  const trimmedId = ref.id.trim();
  if (trimmedId.length === 0) return null;

  // Case-insensitive external ids are folded before mint so `Owner/Repo#786` and
  // `owner/repo#786` do not split (the `integration_object_key` kind itself is
  // not folded by `canonicalizeIdentityValue` — preserve opaque ids).
  const foldedId = trimmedId.toLowerCase();

  // Scope is decided by KIND before provider. `kind: "subject"` is a normalized
  // subject line that a vendor happens to repeat, never a provider-unique id —
  // reading the provider first would promote `[GitHub] Sudo email verification
  // code` to a global `github:subject:…` key. Found on the real corpus, not in a
  // fixture.
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
        // `deriveLoopEntityRef` already lowercases the issue key; the provider is
        // `linear` / `jira` under `requireTrackerSender`, `issue` only without it.
        return globalIssueKey(ref.provider, foldedId);
      }
      // Fallthrough for `pull_request` with non-github provider (should not happen
      // under current contract but keep exhaustive — treat as sender-scoped rather
      // than minting a bogus global key).
      return senderScopedKey(foldedId);
    }
    default: {
      // Exhaustiveness guard. `LoopEntityKind` is a closed union, so this
      // assignment stops compiling the moment a kind is added there — no cast,
      // because a cast would silence exactly the error the guard exists to
      // raise. Scope is a per-kind decision (global vs sender-scoped) and a new
      // kind guessed wrong mints a permanent node, so the build must stop here.
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
 * Every value this module emits is parsed through `identityRefSchema` before it
 * leaves. Parsing the CONTRACT — not re-testing one of its rules — is the point:
 * the schema owns non-emptiness, surrounding whitespace, the
 * `MAX_IDENTITY_VALUE_BYTES` ceiling, canonical form for the kind, AND the
 * registered format. A hand-rolled format check passes an oversized or
 * whitespace-padded value that then fails at `computeStableEntityId` or at the
 * `entity_identities` write, far from this file — which is the outcome this
 * assert exists to prevent. It also means the canonical rule is stated once, in
 * the contract, and never restated as prose here.
 *
 * This throws by design. It is a backstop for a bug in THIS module: every path
 * that can legitimately produce an out-of-contract value already declines to
 * build a key (see {@link MAX_REFERENT_EXTERNAL_ID_BYTES}), so reaching this
 * error means the module built something it should not have.
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
