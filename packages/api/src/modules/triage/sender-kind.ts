import {
  canonicalizeIdentityValue,
  entityKindClassificationSchema,
  type EntityKindClassification,
  type EntityNodeKind,
} from "@alfred/contracts";
import type { ActiveEntityProfile } from "../user-model";
import { userModelReader } from "../user-model";

export const TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD = 0.8;

const TRIAGE_DEMOTING_ENTITY_KINDS = new Set<EntityNodeKind>(["group", "service"]);

export type TriageSenderKindSignal = {
  kind: "group" | "service";
  confidence: number;
  evidenceCodes: string[];
  entityId: string;
  displayName: string;
};

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

function isTriageDemotingEntityKind(kind: EntityNodeKind): kind is TriageSenderKindSignal["kind"] {
  return TRIAGE_DEMOTING_ENTITY_KINDS.has(kind);
}

function classificationFromProfile(profile: ActiveEntityProfile): EntityKindClassification | null {
  const provenance = profile.provenance;
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    !("classification" in provenance)
  ) {
    return null;
  }
  const parsed = entityKindClassificationSchema.safeParse(provenance.classification);
  return parsed.success ? parsed.data : null;
}
