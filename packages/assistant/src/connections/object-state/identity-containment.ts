import {
  collectProviderLinks,
  getObjectDef,
  getStringPath,
  identityAttributes,
  identityProvesLink,
  identityValueForms,
  isNotificationSender,
  isStrongIdentityValue,
  OBJECT_STATE_PROVIDERS,
  type IdentityAttribute,
  type ObjectIdentityDecl,
  type ObjectStateProvider,
} from "@alfred/contracts";
import type { KeyProposal, KeyProposalReading, ReconcileSubject } from "./adapter";
import type { ObjectStateRef, ObjectStateStore } from "./store";

/**
 * Identity containment (ADR-0109 rule 2): evidence names a stored object when one provider link in
 * the text holds each declared identity value of the object, and exactly one object of the kind
 * matches. The registry declares the identity as data, so no provider needs a grammar file.
 *
 * Each link stays one reference. Values from two links never combine into one tuple. A link proves
 * the object only when each value sits after its declared `linkLabel`. Else it only nominates.
 */

/** One provider link of a subject, reduced to its id values, so the prose stays out. */
interface IdentityReference {
  readonly provider: ObjectStateProvider;
  /** Values after a label that the provider declares: `service` → the service id. Any strength. */
  readonly labeled: readonly { readonly label: string; readonly value: string }[];
  /** Every strong value of the link, for a kind that declares no label. */
  readonly strong: readonly string[];
}

/** The provider links of one subject, for identity containment. Not a key. */
export interface IdentityProbe<Reading extends KeyProposalReading> {
  readonly references: readonly IdentityReference[];
  readonly reading: Reading;
}

/** One object a probe names. `proves`: the link carries each value at its label. */
export interface ContainedObject {
  readonly ref: ObjectStateRef;
  readonly proves: boolean;
}

interface IdentityKind {
  provider: ObjectStateProvider;
  kind: string;
  decl: ObjectIdentityDecl;
}

/** Every kind that declares an identity, in registry order. */
const IDENTITY_KINDS: readonly IdentityKind[] = OBJECT_STATE_PROVIDERS.flatMap((provider) =>
  Object.entries(getObjectDef(provider).kinds).flatMap(([kind, def]) =>
    def.identity ? [{ provider, kind, decl: def.identity }] : [],
  ),
);

/** The link labels each provider declares, so a probe keeps only those. */
const LINK_LABELS: ReadonlyMap<ObjectStateProvider, ReadonlySet<string>> = new Map(
  OBJECT_STATE_PROVIDERS.map((provider) => [
    provider,
    new Set(
      IDENTITY_KINDS.filter((entry) => entry.provider === provider).flatMap(({ decl }) =>
        identityAttributes(decl).flatMap((attribute) =>
          attribute.linkLabel ? [attribute.linkLabel] : [],
        ),
      ),
    ),
  ]),
);

const IDENTITY_PROVIDERS: readonly ObjectStateProvider[] = [
  ...new Set(IDENTITY_KINDS.map((entry) => entry.provider)),
];

/**
 * The probe for one subject, or `null` when it can name nothing. Pure. Under `about`, a link counts
 * only when the sender passes its provider's gate, because the briefing drops an item on the result.
 */
export function proposeIdentityProbe<Reading extends KeyProposalReading>(
  subject: ReconcileSubject,
  proposal: Extract<KeyProposal, { reading: Reading }>,
): IdentityProbe<Reading> | null {
  // Widen, so `reading` narrows the union. A deferred generic `Extract` does not narrow.
  const gate: KeyProposal = proposal;

  const providers =
    gate.reading === "about"
      ? IDENTITY_PROVIDERS.filter((provider) => isNotificationSender(provider, gate.sender))
      : IDENTITY_PROVIDERS;

  if (providers.length === 0) return null;

  const references: IdentityReference[] = [];

  for (const link of collectProviderLinks(`${subject.text.subject}\n${subject.text.content}`)) {
    if (!providers.includes(link.provider)) continue;
    const labels = LINK_LABELS.get(link.provider);

    const labeled = link.values.flatMap(({ label, value }) =>
      label !== null && labels?.has(label) ? [{ label, value }] : [],
    );

    const strong = [
      ...new Set(link.values.map(({ value }) => value).filter(isStrongIdentityValue)),
    ];

    if (labeled.length > 0 || strong.length > 0) {
      references.push({ provider: link.provider, labeled, strong });
    }
  }

  return references.length > 0 ? { references, reading: proposal.reading } : null;
}

/**
 * What one reference names for a kind that proves links: one value for each attribute, in declared
 * order. `null` when a label is missing, so the link names no object of the kind. `"ambiguous"`
 * when a label holds two values.
 */
function labeledTuple(
  attributes: readonly IdentityAttribute[],
  reference: IdentityReference,
): readonly string[] | "ambiguous" | null {
  const tuple: string[] = [];

  for (const attribute of attributes) {
    const values = new Set(
      reference.labeled.filter(({ label }) => label === attribute.linkLabel).map((v) => v.value),
    );

    if (values.size === 0) return null;

    if (values.size > 1) return "ambiguous";

    tuple.push(...values);
  }

  return tuple;
}

/** One way a subject may name an object of a kind: a labeled tuple, or the strong values of a link. */
type KindCandidate =
  | { readonly proves: true; readonly tuple: readonly string[] }
  | { readonly proves: false; readonly strong: ReadonlySet<string> };

/**
 * The candidates of one subject for one kind, before the database. Under `about`, a subject whose
 * links name two tuples, or one ambiguous link, names nothing: the database cannot see an object it
 * does not store, so the text alone decides the ambiguity (ADR-0103).
 */
function kindCandidates(
  { provider, decl }: IdentityKind,
  probe: IdentityProbe<KeyProposalReading>,
): KindCandidate[] {
  const references = probe.references.filter((reference) => reference.provider === provider);

  if (!identityProvesLink(decl)) {
    return references.map((reference) => ({ proves: false, strong: new Set(reference.strong) }));
  }

  const attributes = identityAttributes(decl);
  const tuples = new Map<string, readonly string[]>();
  let ambiguous = false;

  for (const reference of references) {
    const tuple = labeledTuple(attributes, reference);

    if (tuple === "ambiguous") ambiguous = true;
    else if (tuple) tuples.set(tuple.join("\u0000"), tuple);
  }

  if (probe.reading === "about" && (ambiguous || tuples.size > 1)) return [];

  return [...tuples.values()].map((tuple) => ({ proves: true, tuple }));
}

/** True when the stored row's identity is the candidate. A weak or missing value never matches. */
function candidateMatches(
  attributes: readonly IdentityAttribute[],
  rowAttributes: unknown,
  candidate: KindCandidate,
): boolean {
  return attributes.every((attribute, index) => {
    const stored = getStringPath(rowAttributes, attribute.attribute);
    const forms = stored === undefined ? null : identityValueForms(attribute, stored);

    if (forms === null) return false;

    if (candidate.proves) {
      const value = candidate.tuple[index];

      return value !== undefined && forms.includes(value);
    }

    return forms.some((form) => candidate.strong.has(form));
  });
}

/** The values to query on the first attribute, in both text forms. */
function firstAttributeValues(attribute: IdentityAttribute, candidate: KindCandidate): string[] {
  const values = candidate.proves
    ? candidate.tuple.slice(0, 1).filter(isStrongIdentityValue)
    : [...candidate.strong];

  return attribute.droppedPrefix
    ? values.flatMap((value) => [value, `${attribute.droppedPrefix}${value}`])
    : values;
}

/**
 * The objects each probe names, keyed by subject id. One query per declared kind for all
 * subjects. A candidate that two rows match names nothing. Under `about`, a subject that names
 * two objects of a kind names none of them.
 */
export async function resolveIdentityProbes(args: {
  store: ObjectStateStore;
  userId: string;
  probes: ReadonlyMap<string, IdentityProbe<KeyProposalReading>>;
  abortSignal?: AbortSignal | undefined;
}): Promise<ReadonlyMap<string, readonly ContainedObject[]>> {
  const found = new Map<string, ContainedObject[]>();

  for (const identityKind of IDENTITY_KINDS) {
    const attributes = identityAttributes(identityKind.decl);
    const [first] = attributes;

    if (!first) continue;

    const candidatesBySubject = new Map<string, KindCandidate[]>();
    const values = new Set<string>();

    for (const [subjectId, probe] of args.probes) {
      const candidates = kindCandidates(identityKind, probe);

      if (candidates.length === 0) continue;
      candidatesBySubject.set(subjectId, candidates);

      for (const candidate of candidates) {
        for (const value of firstAttributeValues(first, candidate)) values.add(value);
      }
    }

    if (values.size === 0) continue;

    // Query on the first attribute only. `candidateMatches` checks the whole tuple after.
    const rows = await args.store.listByIdentityValue(
      args.userId,
      identityKind.provider,
      identityKind.kind,
      first.attribute,
      [...values],
      args.abortSignal,
    );

    if (rows.length === 0) continue;

    for (const [subjectId, candidates] of candidatesBySubject) {
      const named = new Map<string, ContainedObject>();

      for (const candidate of candidates) {
        const matches = rows.filter((row) =>
          candidateMatches(attributes, row.attributes, candidate),
        );

        if (matches.length !== 1 || !matches[0]) continue;
        const { ref } = matches[0];

        // A proving link wins over a nominating one for the same object.
        if (!named.get(ref.objectId)?.proves) {
          named.set(ref.objectId, { ref, proves: candidate.proves });
        }
      }

      if (named.size === 0) continue;

      if (args.probes.get(subjectId)?.reading === "about" && named.size > 1) continue;

      const list = found.get(subjectId) ?? [];

      list.push(...named.values());
      found.set(subjectId, list);
    }
  }

  return found;
}
