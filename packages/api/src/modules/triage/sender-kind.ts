import {
  canonicalizeIdentityValue,
  entityKindClassificationSchema,
  isRecord,
  type EntityKindClassification,
  type EntityNodeKind,
} from "@alfred/contracts";
import { getPreference } from "../memory/preferences";
import type { ActiveEntityProfile } from "../user-model";
import { userModelReader } from "../user-model";

export const TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD = 0.8;
export const TRIAGE_SENDER_KIND_FEATURE_KEY = "feature.internal.triage_sender_kind_projection";

/**
 * Entity kinds that trigger triage person-treatment demotion — a 2-member
 * subset of EntityNodeKind. Single source for the literal set: the membership
 * check ({@link isTriageDemotingEntityKind}), the signal's `kind`, and the
 * decision-trace's `senderKind` all derive from this.
 */
export const TRIAGE_DEMOTING_ENTITY_KINDS = [
  "group",
  "service",
] as const satisfies readonly EntityNodeKind[];
export type TriageDemotingEntityKind = (typeof TRIAGE_DEMOTING_ENTITY_KINDS)[number];

const TRIAGE_DEMOTING_ENTITY_KIND_SET = new Set<EntityNodeKind>(TRIAGE_DEMOTING_ENTITY_KINDS);

export type TriageSenderKindSignal = {
  kind: TriageDemotingEntityKind;
  confidence: number;
  evidenceCodes: string[];
  entityId: string;
  displayName: string;
};

export async function triageSenderKindProjectionEnabled(userId: string): Promise<boolean> {
  const row = await getPreference(userId, TRIAGE_SENDER_KIND_FEATURE_KEY);
  return row ? flagOn(row.value) : true;
}

/**
 * Active-projection sender kind read for triage. Returns a signal only when the
 * projection confidently says this address is a group/service identity. Missing
 * projection data, DB blips, invalid addresses, or person/unknown profiles are
 * no-op by design.
 */
export async function resolveSenderKind(
  userId: string,
  senderAddress: string | null,
): Promise<TriageSenderKindSignal | null> {
  const value = canonicalSenderEmail(senderAddress);
  if (!value) return null;

  try {
    const profile = await userModelReader(userId).getProfileByIdentity({ kind: "email", value });
    return senderKindSignalFromProfile(profile);
  } catch {
    return null;
  }
}

export function senderKindSignalFromProfile(
  profile: ActiveEntityProfile | null,
): TriageSenderKindSignal | null {
  if (!profile || !isTriageDemotingEntityKind(profile.kind)) return null;

  const classification = classificationFromProfile(profile);
  if (!classification) return null;
  if (!isTriageDemotingEntityKind(classification.kind)) return null;
  if (classification.kind !== profile.kind) return null;
  if (classification.confidence < TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD) return null;

  return {
    kind: classification.kind,
    confidence: classification.confidence,
    evidenceCodes: [...classification.evidenceCodes].sort(),
    entityId: profile.entityId,
    displayName: profile.displayName,
  };
}

function canonicalSenderEmail(senderAddress: string | null): string | null {
  const value = senderAddress ? canonicalizeIdentityValue("email", senderAddress) : "";
  if (!value || !value.includes("@")) return null;
  return value;
}

function flagOn(value: unknown): boolean {
  return !(value === false || value === "false" || value === 0);
}

function isTriageDemotingEntityKind(kind: EntityNodeKind): kind is TriageDemotingEntityKind {
  return TRIAGE_DEMOTING_ENTITY_KIND_SET.has(kind);
}

function classificationFromProfile(profile: ActiveEntityProfile): EntityKindClassification | null {
  const provenance = profile.provenance;
  if (!isRecord(provenance)) return null;
  const parsed = entityKindClassificationSchema.safeParse(provenance.classification);
  return parsed.success ? parsed.data : null;
}
