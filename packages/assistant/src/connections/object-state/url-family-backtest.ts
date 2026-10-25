import {
  collectLinkParts,
  containerControl,
  isUrlFamilyHost,
  isUrlFamilySender,
  urlFamilyEvent,
  urlFamilyKeys,
  urlFamilyLinkKey,
  urlFamilyTemplateSchema,
  type StateCategory,
  type UrlFamilyTemplate,
} from "@alfred/contracts";
import { z } from "zod";

const expectedMailPairSchema = z
  .strictObject({
    mailIds: z.tuple([z.string().min(1), z.string().min(1)]),
    relation: z.enum(["same", "different"]),
  })
  .refine(({ mailIds }) => mailIds[0] !== mailIds[1], {
    message: "a pair must name two different mails",
  });

export type UrlFamilyExpectedPair = z.infer<typeof expectedMailPairSchema>;

/** Corpus controls belong to a back-test case, not to the runtime identity template. */
export const urlFamilyBacktestCaseSchema = z.union([
  z.strictObject({
    template: urlFamilyTemplateSchema,
    expectedPairs: z.array(expectedMailPairSchema).default([]),
  }),
  urlFamilyTemplateSchema.transform((template) => ({ template, expectedPairs: [] })),
]);

/**
 * The deterministic back-test of a URL-family template (docs/plans/url-family-identity-templates.md
 * section 5). Pure: the caller loads the mail. PASS checks consistency and the supplied pairs;
 * the owner must still review the template before it may propose keys.
 *
 * - G1: for a `once` kind, no key gets opening events from two threads.
 * - G2: no mail names two keys.
 * - G3: every mail whose subject matches an event also names a key.
 * - G4: the negative control fails. The control is the template with its containers as the
 *   identity, read as `once`. If it passes, the mail cannot tell a container from an item.
 * - G5: declared same-item and different-item pairs must each yield the expected keys. A missing
 *   or unkeyed mail fails the pair, including when it falls outside the selected corpus.
 * - A template that keys no mail has no evidence, so it fails.
 */

export interface BacktestMail {
  readonly id: string;
  readonly threadId: string | null;
  readonly from: string | null;
  readonly subject: string | null;
  readonly content: string;
  readonly authoredAt: Date | null;
}

interface KeyedMail {
  readonly mail: BacktestMail;
  readonly state: StateCategory | null;
  readonly opens: boolean;
}

export interface BacktestKey {
  readonly key: readonly string[];
  /** In time order. */
  readonly mails: readonly KeyedMail[];
  /** G1: opening events from two threads on a `once` key. */
  readonly reopened: boolean;
}

interface GateCounts {
  readonly keys: readonly BacktestKey[];
  readonly ambiguousMails: readonly BacktestMail[];
  readonly coverageMisses: readonly BacktestMail[];
}

export interface UrlFamilyBacktest extends GateCounts {
  readonly template: UrlFamilyTemplate;
  readonly passed: boolean;
  readonly senderMails: number;
  readonly checkedPairs: number;
  readonly pairFailures: readonly UrlFamilyExpectedPair[];
  /** Links on a template host with no single identity, by host. Drift shows here first. */
  readonly unmatchedHosts: ReadonlyMap<string, number>;
  /** `null` when the template declares no container, so no control applies. */
  readonly control: { readonly failed: boolean; readonly reopenedKeys: number } | null;
}

function timeOf(mail: BacktestMail | undefined): number {
  return mail?.authoredAt?.getTime() ?? 0;
}

function runGates(template: UrlFamilyTemplate, mails: readonly BacktestMail[]): GateCounts {
  const byKey = new Map<string, { key: readonly string[]; mails: KeyedMail[] }>();
  const ambiguousMails: BacktestMail[] = [];
  const coverageMisses: BacktestMail[] = [];

  for (const mail of mails) {
    const keys = urlFamilyKeys(template, `${mail.subject ?? ""}\n${mail.content}`);
    const event = urlFamilyEvent(template, mail.subject);
    const [key, ...others] = keys;

    if (others.length > 0) {
      ambiguousMails.push(mail);
      continue;
    }

    if (!key) {
      if (event) coverageMisses.push(mail);
      continue;
    }

    const id = key.join("\u0000");
    const entry = byKey.get(id) ?? { key, mails: [] };

    entry.mails.push({ mail, state: event?.state ?? null, opens: event?.opens === true });
    byKey.set(id, entry);
  }

  const keys = [...byKey.values()].map(({ key, mails: keyed }) => {
    const ordered = keyed.toSorted((a, b) => timeOf(a.mail) - timeOf(b.mail));
    const openingThreads = new Set(ordered.filter((m) => m.opens).map((m) => m.mail.threadId));

    return {
      key,
      mails: ordered,
      reopened: template.lifecycle === "once" && openingThreads.size > 1,
    };
  });

  return {
    keys: keys.toSorted((a, b) => timeOf(a.mails[0]?.mail) - timeOf(b.mails[0]?.mail)),
    ambiguousMails,
    coverageMisses,
  };
}

export function backtestUrlFamilyTemplate(
  template: UrlFamilyTemplate,
  mails: readonly BacktestMail[],
  expectedPairs: readonly UrlFamilyExpectedPair[] = [],
): UrlFamilyBacktest {
  const senderMails = mails.filter((mail) => isUrlFamilySender(template, mail.from));
  const gates = runGates(template, senderMails);

  const keysByMail = new Map(
    gates.keys.flatMap(({ key, mails: keyed }) =>
      keyed.map(({ mail }) => [mail.id, key.join("\u0000")] as const),
    ),
  );

  const pairFailures = expectedPairs.filter(({ mailIds, relation }) => {
    const first = keysByMail.get(mailIds[0]);
    const second = keysByMail.get(mailIds[1]);

    return (
      first === undefined || second === undefined || (first === second) !== (relation === "same")
    );
  });

  const unmatchedHosts = new Map<string, number>();

  for (const mail of senderMails) {
    for (const link of collectLinkParts(`${mail.subject ?? ""}\n${mail.content}`)) {
      if (!isUrlFamilyHost(template, link) || urlFamilyLinkKey(template, link) !== null) {
        continue;
      }

      unmatchedHosts.set(link.host, (unmatchedHosts.get(link.host) ?? 0) + 1);
    }
  }

  const controlTemplate = containerControl(template);
  const controlGates = controlTemplate ? runGates(controlTemplate, senderMails) : null;
  const controlReopened = controlGates?.keys.filter((key) => key.reopened).length ?? 0;

  const control = controlGates && {
    failed: controlReopened > 0 || controlGates.ambiguousMails.length > 0,
    reopenedKeys: controlReopened,
  };

  const passed =
    gates.keys.length > 0 &&
    gates.keys.every((key) => !key.reopened) &&
    gates.ambiguousMails.length === 0 &&
    gates.coverageMisses.length === 0 &&
    pairFailures.length === 0 &&
    (control === null || control.failed);

  return {
    ...gates,
    template,
    passed,
    senderMails: senderMails.length,
    checkedPairs: expectedPairs.length,
    pairFailures,
    unmatchedHosts,
    control,
  };
}
