/**
 * Memory-capture fact policy (#330, ADR-0079) — *which sources write which keys*.
 *
 * Layer 2 of the two-layer capture gate. `@alfred/contracts` owns *what keys
 * exist* (`canonicalizeFactKey` + the one fact ontology); this module owns the
 * trust/source policy that the contracts layer deliberately cannot:
 *
 *   - `classifyDocumentFactKey` — Tier A (authorship-free) / Tier B
 *     (authorship-required) / `not_writable`, over a CANONICAL key.
 *   - `validateFactValueForKey` — context-free structural value checks.
 *   - `SINGLE_VALUED_KEYS` — the keys whose conflict invariant `proposeFact`
 *     enforces (one active authoritative value).
 *   - `authoredByUser` — the ONE check that needs document context ("is this
 *     doc authored by the user?"), evidence-returning and conservative-default-
 *     `false`. Lives here (not in `proposeFact`) because only the workflow has
 *     `doc.metadata` + the connected-account identity; `proposeFact` sees only
 *     `(key, value, source.kind)` by design.
 *
 * Pure module — no DB / LLM. The workflow gate (`memory-extraction.ts`) and the
 * purge script both call these helpers so "junk" has ONE definition.
 */

import {
  canonicalizeFactKey,
  getPath,
  isFactKey,
  isNonEmptyString,
  isRecord,
  PREF_FACT_PREFIX,
  RELATIONSHIP_FACT_PREFIX,
  type FactKey,
} from "@alfred/contracts";
import type { documents } from "@alfred/db/schemas";
import { extractSenderContext } from "../triage/sender-context";
import { isSentGmailMetadata } from "../triage/sent-mail";

// ---------------------------------------------------------------------------
// document write tiers
// ---------------------------------------------------------------------------

export type DocumentFactTier = "tierA" | "tierB" | "not_writable";

/**
 * Which write tier a CANONICAL fact key falls into for the per-document path.
 * Pass the output of `canonicalizeFactKey`, not a raw producer key.
 *
 *  - **Tier A (authorship-free):** `relationship:<email>` only — an inbound
 *    email legitimately establishes *the user's* social graph regardless of who
 *    sent it.
 *  - **Tier B (authorship-required):** the canonical identity/profile keys —
 *    a durable claim about the user that only holds if the user authored the doc.
 *  - **`not_writable`:** everything else — `pref:*`, `standing_instruction`,
 *    `phone_number`, and any unknown/junk key. Durable preferences from email is
 *    a separate product problem; phone numbers need a typed value first.
 */
export function classifyDocumentFactKey(canonicalKey: string): DocumentFactTier {
  if (canonicalKey.startsWith(RELATIONSHIP_FACT_PREFIX)) return "tierA";
  if (isFactKey(canonicalKey)) return "tierB";
  return "not_writable";
}

// ---------------------------------------------------------------------------
// value-shape validation (source-agnostic, context-free)
// ---------------------------------------------------------------------------

export type FactValueRejectReason = "expected_string_value" | "invalid_relationship_value";

export type FactValueValidation = { ok: true } | { ok: false; reason: FactValueRejectReason };

/**
 * Structural value check for a CANONICAL key. Source-agnostic invariant (no
 * document context):
 *
 *  - `relationship:<email>` — the valid-email KEY is what establishes the
 *    social-graph edge (Tier A intent), so the value is permissive: a role
 *    string OR any object, INCLUDING an empty `{}` (a known correspondent whose
 *    role we haven't captured yet — `{role, since?}` is enrichment, not a floor).
 *    Only a clearly-wrong primitive (number/boolean/null/array/empty string) is
 *    rejected. Malformed relationship KEYS are caught upstream by
 *    `canonicalizeFactKey`, not here.
 *  - `pref:<name>` — freeform (preferences hold arbitrary JSON).
 *  - every canonical identity/profile key — a non-empty string (names, summaries,
 *    cities, handles, URLs, timezone, birthday are all string-valued).
 */
export function validateFactValueForKey(canonicalKey: string, value: unknown): FactValueValidation {
  if (canonicalKey.startsWith(RELATIONSHIP_FACT_PREFIX)) {
    if (isNonEmptyString(value)) return { ok: true };
    if (isRecord(value)) return { ok: true };
    return { ok: false, reason: "invalid_relationship_value" };
  }
  if (canonicalKey.startsWith(PREF_FACT_PREFIX)) return { ok: true };
  if (isNonEmptyString(value)) return { ok: true };
  return { ok: false, reason: "expected_string_value" };
}

// ---------------------------------------------------------------------------
// single-valued conflict keys
// ---------------------------------------------------------------------------

/**
 * Keys that may have at most ONE active authoritative value — a new differing
 * value is a conflict `proposeFact` holds as `proposed` (autonomous sources) or
 * supersedes (user-driven). Source-agnostic.
 *
 * `employer`/`job_title`/`location`/`home_city`/`home_country` are modeled as
 * the CURRENT active profile fact; history is superseded rows + validity
 * windows, not parallel keys. Deliberately omitted (multi-valued, no conflict
 * check): `relationship:*`, `pref:*`, `phone_number`, and the open-ended
 * `family_summary` / `notable_relations` paragraphs.
 */
export const SINGLE_VALUED_KEYS = [
  "full_name",
  "first_name",
  "last_name",
  "user_nickname",
  "employer",
  "work_summary",
  "job_title",
  "team",
  "manager",
  "location",
  "home_city",
  "home_country",
  "timezone",
  "birthday",
  "marital_status",
  "spouse_name",
  "personal_site",
  "github_username",
  "twitter_handle",
  "linkedin_url",
  "bio_summary",
] as const satisfies readonly FactKey[];

const singleValuedKeySet: ReadonlySet<string> = new Set(SINGLE_VALUED_KEYS);

/** True iff a CANONICAL key carries the at-most-one-active-value invariant. */
export function isSingleValuedKey(canonicalKey: string): boolean {
  return singleValuedKeySet.has(canonicalKey);
}

// ---------------------------------------------------------------------------
// authorship ("is this document authored by the user?")
// ---------------------------------------------------------------------------

export type AuthorshipSource =
  | "gmail"
  | "slack"
  | "github"
  | "gcal"
  | "notion"
  | "imessage"
  | "upload"
  | "unknown";

export type AuthorshipIdentity =
  | { kind: "email"; value: string; accountId?: string }
  | { kind: "provider_user_id"; provider: "slack" | "github"; value: string; workspaceId?: string }
  | { kind: "provider_login"; provider: "github"; value: string };

export type AuthorshipProof =
  | {
      source: "gmail";
      method: "sent_flag";
      accountId: string | null;
      accountEmail: string | null;
      fromEmail: string | null;
    }
  | {
      source: "gmail";
      method: "from_connected_account";
      accountId: string | null;
      accountEmail: string;
      fromEmail: string;
    }
  | {
      source: "slack";
      method: "author_user_id" | "author_email";
      observed: AuthorshipIdentity;
      matchedSelf: AuthorshipIdentity;
    }
  | {
      source: "github";
      method: "author_id" | "author_login";
      observed: AuthorshipIdentity;
      matchedSelf: AuthorshipIdentity;
    };

export type AuthorshipRejectReason =
  | "unsupported_source"
  | "missing_self_identity"
  | "missing_author_identity"
  | "identity_mismatch"
  | "ambiguous_author"
  | "metadata_unparseable";

export type Authorship =
  | { authoredByUser: true; source: AuthorshipSource; proof: AuthorshipProof }
  | {
      authoredByUser: false;
      source: AuthorshipSource;
      reason: AuthorshipRejectReason;
      observed?: AuthorshipIdentity;
    };

/**
 * The document context `authoredByUser` reads. Derived from the `documents` row
 * so the shape can't drift from the schema (`metadata` is untyped `jsonb` →
 * `unknown`, narrowed here at the boundary).
 */
export type AuthorshipDocument = Pick<
  typeof documents.$inferSelect,
  "source" | "metadata" | "accountId"
>;

/**
 * Everything `authoredByUser` needs to recognize "the user" across providers.
 * Conservative by construction: an absent provider identity makes that
 * provider's docs fail attribution (`missing_self_identity`), never pass.
 */
export interface SelfIdentity {
  /**
   * Lowercased self emails — global `user.email` PLUS every connected Gmail
   * account email. Used as the fallback match set when a doc has no `accountId`.
   */
  readonly emails: readonly string[];
  /**
   * `documents.accountId` → that connected Gmail account's email (lowercased).
   * Preferred over the global set so a work mailbox isn't matched against a
   * personal address (and vice versa).
   */
  readonly gmailAccountEmailById?: Readonly<Record<string, string>>;
  /** Self GitHub identity, if known. */
  readonly github?: { login?: string | null; userId?: string | null };
  /** Self Slack identity, if known (stable user-id and/or verified emails). */
  readonly slack?: { userId?: string | null; emails?: readonly string[] };
}

function toAuthorshipSource(source: string): AuthorshipSource {
  switch (source) {
    case "gmail":
      return "gmail";
    case "slack":
      return "slack";
    case "github":
      return "github";
    case "gcal":
    case "google_calendar":
      return "gcal";
    case "notion":
      return "notion";
    case "imessage":
      return "imessage";
    case "upload":
    case "uploads":
      return "upload";
    default:
      return "unknown";
  }
}

/** Parse the lowercased `local@domain` from a raw `From:` header, or null. */
function parseFromEmail(fromHeader: string): string | null {
  return extractSenderContext({ fromHeader, subject: null, body: "" }).senderAddress;
}

function authoredByGmail(
  metadata: unknown,
  accountId: string | null,
  self: SelfIdentity,
): Authorship {
  const accountEmail =
    (accountId && self.gmailAccountEmailById?.[accountId]?.toLowerCase()) || null;

  const isSent = isSentGmailMetadata(isRecord(metadata) ? metadata : null);
  const fromRaw = isRecord(metadata) && typeof metadata.from === "string" ? metadata.from : null;
  const fromEmail = fromRaw ? parseFromEmail(fromRaw) : null;

  // Gmail's SENT label is set by the connected mailbox itself — sufficient proof
  // even when the `From` is absent (`from_connected_account` needs the equality).
  if (isSent) {
    return {
      authoredByUser: true,
      source: "gmail",
      proof: { source: "gmail", method: "sent_flag", accountId, accountEmail, fromEmail },
    };
  }

  if (!fromEmail) {
    return { authoredByUser: false, source: "gmail", reason: "missing_author_identity" };
  }

  // Match the parsed From against the connected-account email first, then the
  // global self-email set (covers a doc with no resolvable accountId).
  const selfEmails = new Set<string>(self.emails.map((e) => e.toLowerCase()));
  if (accountEmail) selfEmails.add(accountEmail);
  if (selfEmails.size === 0) {
    return {
      authoredByUser: false,
      source: "gmail",
      reason: "missing_self_identity",
      observed: { kind: "email", value: fromEmail },
    };
  }
  if (selfEmails.has(fromEmail)) {
    return {
      authoredByUser: true,
      source: "gmail",
      proof: {
        source: "gmail",
        method: "from_connected_account",
        accountId,
        // The matched self email IS the authoring mailbox.
        accountEmail: accountEmail ?? fromEmail,
        fromEmail,
      },
    };
  }
  return {
    authoredByUser: false,
    source: "gmail",
    reason: "identity_mismatch",
    observed: { kind: "email", value: fromEmail },
  };
}

/** First non-empty string at any of `paths` in `metadata`, else null. */
function firstMetaString(metadata: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const v = getPath(metadata, path);
    if (isNonEmptyString(v)) return v;
  }
  return null;
}

function authoredByGithub(metadata: unknown, self: SelfIdentity): Authorship {
  const selfLogin = self.github?.login?.toLowerCase() || null;
  const selfUserId = self.github?.userId || null;
  if (!selfLogin && !selfUserId) {
    return { authoredByUser: false, source: "github", reason: "missing_self_identity" };
  }
  const authorId = firstMetaString(metadata, ["authorId", "author_id"]);
  const authorLogin = firstMetaString(metadata, [
    "authorLogin",
    "author_login",
    "authorHandle",
    "author",
  ]);
  if (!authorId && !authorLogin) {
    return { authoredByUser: false, source: "github", reason: "missing_author_identity" };
  }
  if (selfUserId && authorId && authorId === selfUserId) {
    return {
      authoredByUser: true,
      source: "github",
      proof: {
        source: "github",
        method: "author_id",
        observed: { kind: "provider_user_id", provider: "github", value: authorId },
        matchedSelf: { kind: "provider_user_id", provider: "github", value: selfUserId },
      },
    };
  }
  if (selfLogin && authorLogin && authorLogin.toLowerCase() === selfLogin) {
    return {
      authoredByUser: true,
      source: "github",
      proof: {
        source: "github",
        method: "author_login",
        observed: { kind: "provider_login", provider: "github", value: authorLogin },
        matchedSelf: { kind: "provider_login", provider: "github", value: selfLogin },
      },
    };
  }
  return {
    authoredByUser: false,
    source: "github",
    reason: "identity_mismatch",
    observed: authorLogin
      ? { kind: "provider_login", provider: "github", value: authorLogin }
      : { kind: "provider_user_id", provider: "github", value: authorId ?? "" },
  };
}

function authoredBySlack(metadata: unknown, self: SelfIdentity): Authorship {
  const selfUserId = self.slack?.userId || null;
  const selfEmails = new Set((self.slack?.emails ?? []).map((e) => e.toLowerCase()));
  if (!selfUserId && selfEmails.size === 0) {
    return { authoredByUser: false, source: "slack", reason: "missing_self_identity" };
  }
  const authorUserId = firstMetaString(metadata, ["authorUserId", "author_user_id", "userId"]);
  const authorEmail = firstMetaString(metadata, ["authorEmail", "author_email"])?.toLowerCase();
  if (!authorUserId && !authorEmail) {
    return { authoredByUser: false, source: "slack", reason: "missing_author_identity" };
  }
  if (selfUserId && authorUserId && authorUserId === selfUserId) {
    return {
      authoredByUser: true,
      source: "slack",
      proof: {
        source: "slack",
        method: "author_user_id",
        observed: { kind: "provider_user_id", provider: "slack", value: authorUserId },
        matchedSelf: { kind: "provider_user_id", provider: "slack", value: selfUserId },
      },
    };
  }
  if (authorEmail && selfEmails.has(authorEmail)) {
    return {
      authoredByUser: true,
      source: "slack",
      proof: {
        source: "slack",
        method: "author_email",
        observed: { kind: "email", value: authorEmail },
        matchedSelf: { kind: "email", value: authorEmail },
      },
    };
  }
  return {
    authoredByUser: false,
    source: "slack",
    reason: "identity_mismatch",
    observed: authorUserId
      ? { kind: "provider_user_id", provider: "slack", value: authorUserId }
      : { kind: "email", value: authorEmail ?? "" },
  };
}

/**
 * Evidence-returning authorship decision, conservative-default-`false`. Answers
 * "is this document authored by the user?", NOT "is it about the user?" (the
 * latter is LLM territory). `gcal`/`notion`/`imessage`/uploads/unknown describe
 * attendees, organizers, or third-party content — never durable user identity —
 * so they are `unsupported_source` in this slice.
 */
export function authoredByUser(doc: AuthorshipDocument, self: SelfIdentity): Authorship {
  const source = toAuthorshipSource(doc.source);
  switch (source) {
    case "gmail":
      return authoredByGmail(doc.metadata, doc.accountId, self);
    case "github":
      return authoredByGithub(doc.metadata, self);
    case "slack":
      return authoredBySlack(doc.metadata, self);
    case "gcal":
    case "notion":
    case "imessage":
    case "upload":
    case "unknown":
      return { authoredByUser: false, source, reason: "unsupported_source" };
    default: {
      const _exhaustive: never = source;
      return { authoredByUser: false, source: _exhaustive, reason: "unsupported_source" };
    }
  }
}

// ---------------------------------------------------------------------------
// document fact gate (the workflow's diagnostic wrapper)
// ---------------------------------------------------------------------------

export type DocumentFactGateReject =
  | "unknown_key"
  | "invalid_relationship_key"
  | "invalid_value"
  | "not_document_writable"
  | "authorship_required";

export type DocumentFactGateResult =
  | {
      ok: true;
      key: string;
      value: unknown;
      meta?: Record<string, unknown>;
      authorship?: Authorship;
    }
  | {
      ok: false;
      reason: DocumentFactGateReject;
      originalKey: string;
      canonicalKey?: string;
      authorship?: Authorship;
    };

export interface DocumentFactGateInput {
  readonly proposal: { key: string; value: unknown };
  readonly document: AuthorshipDocument;
  readonly selfIdentity: SelfIdentity;
}

/**
 * The full per-document write decision (#330, ADR-0079 §3b) — a DIAGNOSTIC
 * wrapper the workflow runs BEFORE `proposeFact`. It calls the SAME pure helpers
 * (`canonicalizeFactKey` / `classifyDocumentFactKey` / `validateFactValueForKey`)
 * plus the one contextual check `proposeFact` cannot do: `authoredByUser`.
 * `proposeFact` stays the unbypassable backstop even if a future caller forgets
 * this gate — the only thing UNIQUE here is the authorship attribution.
 *
 *  - unknown / bad relationship key → reject (`invalid_relationship_key` when the
 *    raw key was `relationship:*`, else `unknown_key`);
 *  - `not_writable` canonical key → `not_document_writable`;
 *  - invalid value shape → `invalid_value` (or `invalid_relationship_key` for a
 *    malformed relationship edge);
 *  - Tier B (identity/profile) key whose document is NOT authored by the user →
 *    `authorship_required` (carries the authorship evidence for the trace);
 *  - Tier A (`relationship:<email>`) is authorship-free → passes.
 */
export function gateDocumentFact(input: DocumentFactGateInput): DocumentFactGateResult {
  const { proposal, document, selfIdentity } = input;
  const canon = canonicalizeFactKey(proposal.key);
  if (!canon.ok) {
    return {
      ok: false,
      reason: proposal.key.trim().startsWith(RELATIONSHIP_FACT_PREFIX)
        ? "invalid_relationship_key"
        : "unknown_key",
      originalKey: proposal.key,
    };
  }
  const canonicalKey = canon.key;

  const tier = classifyDocumentFactKey(canonicalKey);
  if (tier === "not_writable") {
    return { ok: false, reason: "not_document_writable", originalKey: proposal.key, canonicalKey };
  }
  if (!validateFactValueForKey(canonicalKey, proposal.value).ok) {
    return {
      ok: false,
      reason: canonicalKey.startsWith(RELATIONSHIP_FACT_PREFIX)
        ? "invalid_relationship_key"
        : "invalid_value",
      originalKey: proposal.key,
      canonicalKey,
    };
  }

  const meta = canon.wasAlias ? { originalKey: canon.originalKey } : undefined;

  // Tier A (relationship) is authorship-free. Tier B needs the user to have
  // authored the document.
  if (tier === "tierB") {
    const authorship = authoredByUser(document, selfIdentity);
    if (!authorship.authoredByUser) {
      return {
        ok: false,
        reason: "authorship_required",
        originalKey: proposal.key,
        canonicalKey,
        authorship,
      };
    }
    return { ok: true, key: canonicalKey, value: proposal.value, meta, authorship };
  }

  return { ok: true, key: canonicalKey, value: proposal.value, meta };
}
