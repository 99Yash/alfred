/**
 * Memory-capture fact policy (#330, ADR-0079): which sources may write which keys.
 * `@alfred/contracts` owns which keys exist; this module owns trust. Pure, no DB or LLM.
 * The workflow gate and the purge script share it, so "junk" has one definition.
 */

import {
  canonicalizeFactKey,
  classifyConnectedAccount,
  getPath,
  isFactKey,
  isNonEmptyString,
  isRecord,
  PREF_FACT_PREFIX,
  RELATIONSHIP_FACT_PREFIX,
  type FactKey,
  type JsonObject,
  type GmailAuthorshipObservation,
} from "@alfred/contracts";
import type { Document } from "@alfred/db/schemas";

// --- document write tiers ---

export type DocumentFactTier = "tierA" | "tierB" | "not_writable";

/**
 * The write tier of a canonical key on the per-document path.
 * Tier A (`relationship:<email>`): no authorship needed; any inbound mail builds the social graph.
 * Tier B (identity/profile keys): the user must have authored the doc.
 * `not_writable`: `pref:*`, `standing_instruction`, `phone_number`, and unknown keys.
 */
export function classifyDocumentFactKey(canonicalKey: string): DocumentFactTier {
  if (canonicalKey.startsWith(RELATIONSHIP_FACT_PREFIX)) return "tierA";

  if (isFactKey(canonicalKey)) return "tierB";

  return "not_writable";
}

// --- service-sender / uninformative relationship classifier (#491 / #492) ---

/** True for a no-reply, service, or role mailbox. The memory module's one definition (ADR-0080). */
export function isServiceSender(email: string): boolean {
  return classifyConnectedAccount({ email }) === "service_or_role_account";
}

/** The `<email>` half of a canonical `relationship:<email>` key, or null. */
function relationshipEmail(canonicalKey: string): string | null {
  if (!canonicalKey.startsWith(RELATIONSHIP_FACT_PREFIX)) return null;
  const email = canonicalKey.slice(RELATIONSHIP_FACT_PREFIX.length).trim();

  return email.length > 0 ? email : null;
}

/** For inbound mail the key's correspondent is the sender, so the key alone decides. */
function isServiceSenderRelationshipKey(canonicalKey: string): boolean {
  const email = relationshipEmail(canonicalKey);

  return email != null && isServiceSender(email);
}

/** True if a nested field has any reviewable content. */
function fieldHasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;

  if (typeof value === "number" || typeof value === "boolean") return true;

  if (Array.isArray(value)) return value.some(fieldHasContent);

  if (isRecord(value)) return Object.values(value).some(fieldHasContent);

  return false;
}

/** True when a `relationship:<email>` value has nothing to review: blank, empty, or not a string or object. */
export function isUninformativeRelationshipValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length === 0;

  if (isRecord(value)) return !Object.values(value).some(fieldHasContent);

  return true;
}

/** The one junk test for `relationship:<email>` facts: a service sender or an empty value. Pass a canonical key. */
export function isUninformativeRelationshipFact(key: string, value: unknown): boolean {
  if (!key.startsWith(RELATIONSHIP_FACT_PREFIX)) return false;

  return isServiceSenderRelationshipKey(key) || isUninformativeRelationshipValue(value);
}

// --- value-shape validation (source-agnostic, context-free) ---

export type FactValueRejectReason = "expected_string_value" | "invalid_relationship_value";

export type FactValueValidation = { ok: true } | { ok: false; reason: FactValueRejectReason };

/**
 * Structural value check for a canonical key. `relationship:<email>` needs a
 * non-empty role or a `{ role, since? }` with content. `pref:*` is freeform.
 * Identity and profile keys need a non-empty string.
 */
export function validateFactValueForKey(canonicalKey: string, value: unknown): FactValueValidation {
  if (canonicalKey.startsWith(RELATIONSHIP_FACT_PREFIX)) {
    return isUninformativeRelationshipValue(value)
      ? { ok: false, reason: "invalid_relationship_value" }
      : { ok: true };
  }

  if (canonicalKey.startsWith(PREF_FACT_PREFIX)) return { ok: true };

  if (isNonEmptyString(value)) return { ok: true };

  return { ok: false, reason: "expected_string_value" };
}

// --- single-valued conflict keys ---

/**
 * Keys with at most one active value. `proposeFact` holds a differing autonomous
 * value as `proposed` and lets a user value supersede. History is superseded rows.
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

/** True if a canonical key allows only one active value. */
export function isSingleValuedKey(canonicalKey: string): boolean {
  return singleValuedKeySet.has(canonicalKey);
}

// --- authorship ---

/**
 * Sources that can carry an author. Attachments and Sentry events map to
 * `unknown`, which rejects. The cleanup backfill passes `unknown` for a missing document.
 */
export type AuthorshipSource = "gmail" | "github" | "unknown";

export type AuthorshipIdentity =
  | { kind: "email"; value: string; accountId?: string }
  | { kind: "provider_user_id"; provider: "github"; value: string; workspaceId?: string }
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
 * The document context `authoredByUser` reads. `sender` is the parsed Gmail
 * authorship observation (ADR-0089); `null` for non-Gmail docs.
 */
export type AuthorshipDocument =
  | (Pick<Document, "source" | "metadata" | "accountId"> & {
      sender: GmailAuthorshipObservation | null;
    })
  | {
      source: "unknown";
      metadata: unknown;
      accountId: null;
      sender: GmailAuthorshipObservation | null;
    };

/** Who "the user" is per provider. A missing provider identity fails attribution. */
export interface SelfIdentity {
  /** Lowercased self emails: `user.email` plus every connected Gmail account. Fallback when a doc has no `accountId`. */
  readonly emails: readonly string[];
  /** `documents.accountId` to that mailbox's email, so a work mailbox is not matched to a personal address. */
  readonly gmailAccountEmailById?: Readonly<Record<string, string>>;
  readonly github?: { login?: string | null; userId?: string | null };
}

/** Typed on `AuthorshipDocument["source"]`, so a new document source breaks this switch. */
function toAuthorshipSource(source: AuthorshipDocument["source"]): AuthorshipSource {
  switch (source) {
    case "gmail":
      return "gmail";
    case "github":
      return "github";
    // Neither an attachment nor a machine event can prove user authorship.
    case "gmail_attachment":
    case "sentry":
    case "unknown":
      return "unknown";
    default: {
      const _exhaustive: never = source;

      return _exhaustive;
    }
  }
}

function authoredByGmail(
  sender: GmailAuthorshipObservation | null,
  accountId: string | null,
  self: SelfIdentity,
): Authorship {
  const accountEmail =
    (accountId && self.gmailAccountEmailById?.[accountId]?.toLowerCase()) || null;

  // The triage adapter parses `From:` and SENT (ADR-0089). No observation reads as not sent.
  const isSent = sender?.isSent ?? false;
  const fromEmail = sender?.fromEmail ?? null;

  // The SENT label comes from the mailbox itself, so it proves authorship without `From`.
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

  // A doc tied to a mailbox must match that mailbox, not any self email.
  if (accountEmail) {
    if (fromEmail === accountEmail) {
      return {
        authoredByUser: true,
        source: "gmail",
        proof: {
          source: "gmail",
          method: "from_connected_account",
          accountId,
          accountEmail,
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

  // No `accountId` (legacy rows): fall back to every self email.
  const selfEmails = new Set<string>(self.emails.map((e) => e.toLowerCase()));

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
        accountEmail: fromEmail,
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

/** First non-empty string at any of `paths`, else null. */
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

/** Is this document authored by the user (not "about" the user)? Defaults to `false`. */
export function authoredByUser(doc: AuthorshipDocument, self: SelfIdentity): Authorship {
  const source = toAuthorshipSource(doc.source);

  switch (source) {
    case "gmail":
      return authoredByGmail(doc.sender, doc.accountId, self);
    case "github":
      return authoredByGithub(doc.metadata, self);
    case "unknown":
      return { authoredByUser: false, source, reason: "unsupported_source" };
    default: {
      const _exhaustive: never = source;

      return { authoredByUser: false, source: _exhaustive, reason: "unsupported_source" };
    }
  }
}

// --- document fact gate ---

export type DocumentFactGateReject =
  | "unknown_key"
  | "invalid_relationship_key"
  | "invalid_value"
  | "service_sender_relationship"
  | "not_document_writable"
  | "authorship_required";

export type DocumentFactGateResult =
  | {
      ok: true;
      key: string;
      value: unknown;
      meta?: JsonObject | undefined;
      authorship?: Authorship | undefined;
    }
  | {
      ok: false;
      reason: DocumentFactGateReject;
      originalKey: string;
      canonicalKey?: string | undefined;
      authorship?: Authorship | undefined;
    };

export interface DocumentFactGateInput {
  readonly proposal: { key: string; value: unknown };
  readonly document: AuthorshipDocument;
  readonly selfIdentity: SelfIdentity;
}

/**
 * The per-document write decision (#330, ADR-0079 §3b), run before `proposeFact`
 * for diagnostics. `proposeFact` stays the real backstop; only the authorship check is unique here.
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

  // A service sender is never a relationship, even with a real-looking role (#492).
  if (isServiceSenderRelationshipKey(canonicalKey)) {
    return {
      ok: false,
      reason: "service_sender_relationship",
      originalKey: proposal.key,
      canonicalKey,
    };
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
