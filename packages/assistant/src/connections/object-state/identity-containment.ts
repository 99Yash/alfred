import {
  collectIdentityTokens,
  getObjectDef,
  identityAttributes,
  identityContained,
  isNotificationSender,
  OBJECT_STATE_PROVIDERS,
  type ObjectIdentityDecl,
  type ObjectStateProvider,
} from "@alfred/contracts";
import type { IdentityProbe, KeyProposal, KeyProposalReading, ReconcileSubject } from "./adapter";
import type { ObjectStateRef, ObjectStateStore } from "./store";

/**
 * Identity containment (ADR-0109 rule 2): evidence names a stored object when each declared
 * identity value of the object occurs in the text as a strong token, and exactly one object of the
 * kind matches. The registry declares the identity as data, so no provider needs a grammar file.
 */

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

const IDENTITY_PROVIDERS: readonly ObjectStateProvider[] = [
  ...new Set(IDENTITY_KINDS.map((entry) => entry.provider)),
];

/**
 * The probe for one subject, or `null` when it can name nothing. Pure. Under `about`, a provider
 * counts only when the sender passes its gate, because the briefing drops an item on the result.
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

  const tokens = collectIdentityTokens(`${subject.text.subject}\n${subject.text.content}`);

  if (tokens.length === 0) return null;

  return { providers, tokens, reading: proposal.reading };
}

/**
 * The objects each probe names, keyed by subject id. One query per declared kind for all
 * subjects. A kind that two rows match names nothing for that subject.
 */
export async function resolveIdentityProbes(args: {
  store: ObjectStateStore;
  userId: string;
  probes: ReadonlyMap<string, IdentityProbe<KeyProposalReading>>;
  abortSignal?: AbortSignal | undefined;
}): Promise<ReadonlyMap<string, readonly ObjectStateRef[]>> {
  const found = new Map<string, ObjectStateRef[]>();

  for (const { provider, kind, decl } of IDENTITY_KINDS) {
    const probes = [...args.probes].filter(([, probe]) => probe.providers.includes(provider));

    if (probes.length === 0) continue;

    // Query on the first attribute only. `identityContained` checks the whole tuple after.
    const [first] = identityAttributes(decl);

    if (!first) continue;

    const values = new Set<string>();

    for (const [, probe] of probes) {
      for (const token of probe.tokens) {
        values.add(token);

        if (first.droppedPrefix) values.add(`${first.droppedPrefix}${token}`);
      }
    }

    args.abortSignal?.throwIfAborted();

    const rows = await args.store.listByIdentityValue(
      args.userId,
      provider,
      kind,
      first.attribute,
      [...values],
    );

    if (rows.length === 0) continue;

    for (const [subjectId, probe] of probes) {
      const tokens = new Set(probe.tokens);
      const matches = rows.filter((row) => identityContained(decl, row.attributes, tokens));

      if (matches.length !== 1 || !matches[0]) continue;

      const list = found.get(subjectId) ?? [];

      list.push(matches[0].ref);
      found.set(subjectId, list);
    }
  }

  return found;
}
