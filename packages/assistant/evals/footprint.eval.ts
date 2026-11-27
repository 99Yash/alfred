import path from "node:path";
import { collectLinkParts, parseMailbox } from "@alfred/contracts";
import { closeConnections } from "@alfred/db";
import {
  admitsFootprintObject,
  foldFootprint,
  footprintMailTouch,
  FOOTPRINT_CORPUS_CONFIRM_CAP,
  FOOTPRINT_LOOKBACK_DAYS,
  FOOTPRINT_MIN_CORPUS_THREADS,
  readFootprint,
  type FootprintAnswer,
  type FootprintCorpusLeg,
  type FootprintLeg,
  type FootprintMailTouch,
  type FootprintObjectMatch,
  type FootprintQuery,
  type FootprintSight,
  type FootprintVerdict,
} from "@alfred/assistant/knowledge/footprint";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import {
  deleteEvalUser,
  seedEvalUser,
  seedGithubCredential,
  seedObjectRow,
  seedRailwayMcpConnection,
  seedTriageThread,
} from "./lib/stored-rows";

/**
 * The ADR-0135 eval deck, slice 1. It grades the footprint projection at three depths
 * (ADR-0133 decision 1: each case cites the decision and the theory line it guards — the
 * `decision` and `guards` fields on every case):
 *
 * - **The fold** (`foldFootprint`) against sight snapshots the real stores would hand it —
 *   cheap, no database, run on every touch of the fold.
 * - **The admission and touch rules** (`admitsFootprintObject`, `footprintMailTouch`) on their
 *   own, with the sender input the reader parses, not a pre-matched hit.
 * - **The reader** (`readFootprint`) against real stored rows — redacted synthetic mail in
 *   real `documents`, `email_triage`, `integration_objects`, `integration_object_keys`,
 *   `integration_credentials` and MCP rows in the local Postgres — grading the verdict AND the
 *   exact evidence (stores cited, matched domains, coverage fields), the "real corpus cases"
 *   of decision D5. Needs the local Postgres (`apps/server/.env`); the other suites need
 *   nothing. Run it alone:
 *   `pnpm --filter @alfred/assistant exec evalite run footprint`.
 *
 * The worst error is the ADR's own (D5): a broadcast that does touch the owner's world demoted
 * to a passing line. The Render case is the measured fault that produced the ADR (2026-11-26).
 */

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

/**
 * The theory the deck guards, per ADR-0133 decision 1: the ADR decision whose rule a case
 * grades, and the theory section or principle it protects.
 */
interface Guarded {
  /** The ADR-0135 decision (or amendment) whose rule the case grades. */
  readonly decision: string;
  /** The theory section or principle the case protects. */
  readonly guards: string;
}

// ---------------------------------------------------------------------------
// The fold, against sight snapshots
// ---------------------------------------------------------------------------

interface Case extends Guarded {
  readonly name: string;
  readonly query: FootprintQuery;
  readonly sight: FootprintSight;
  readonly expected: FootprintVerdict;
}

/** The corpus leg of a confident negative: months of triaged mail, read in full and empty. */
const READ_CORPUS: FootprintCorpusLeg = {
  status: "read",
  lookbackDays: FOOTPRINT_LOOKBACK_DAYS,
  threadsRead: 1_486,
  unreadMail: 0,
  nominated: 0,
  mailsChecked: 0,
  historyGapped: false,
  hits: [],
};

const NO_CONNECTIONS: FootprintLeg<never> = { status: "empty" };

const NO_OBJECTS: FootprintLeg<never> = { status: "empty" };

const RAILWAY_OWNED: FootprintSight = {
  connections: NO_CONNECTIONS,
  objects: {
    status: "hit",
    hits: [
      {
        objectId: "iobj_deploy_1",
        provider: "railway",
        kind: "deployment",
        title: "alfred production",
        url: "https://railway.com/project/alfred/service/alfred-prod",
        matched: { via: "provider", provider: "railway" },
      },
    ],
  },
  corpus: READ_CORPUS,
};

const RENDER_ABSENT: FootprintSight = {
  connections: NO_CONNECTIONS,
  objects: NO_OBJECTS,
  corpus: READ_CORPUS,
};

const CASES: readonly Case[] = [
  {
    name: "The worst error: a Railway incident naming an owned deployment is not demoted",
    decision:
      "ADR-0135 D5 — the named worst error: a broadcast that does touch the owner's world demoted",
    guards: "D2 — loop asks (mail naming an owned thing) keep today's weight",
    query: { slug: "railway", domains: ["railway.app", "railway.com"] },
    sight: RAILWAY_OWNED,
    expected: "in-footprint",
  },
  {
    name: "The Render notice: no connection, no object, months of mail with no mention",
    decision:
      "ADR-0135 D1 — a confident not-in-footprint carries the absence proof as corpus evidence",
    guards:
      "context-graph.md — the verdict is a query-time projection, recomputed, never persisted (memory principle 5)",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: RENDER_ABSENT,
    expected: "not-in-footprint",
  },
  {
    name: "Thin sight: a corpus the fold could barely see stays unknown",
    decision:
      "ADR-0135 D5 — only a confident negative changes ranking; unknown keeps today's weight",
    guards: "D1 — unknown is the honest state when sight is thin",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { ...READ_CORPUS, threadsRead: 12 } },
    expected: "unknown",
  },
  {
    name: "A faulted corpus leg never backs a negative",
    decision: "ADR-0135 D5 — the demotion bar is positive sight, never 'we couldn't look'",
    guards: "D1 — the negative is an inference over what the stores hold today",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { status: "unreadable" } },
    expected: "unknown",
  },
  {
    name: "Triaged threads whose mail never arrived are not corpus sight",
    decision:
      "ADR-0135 D5 amendment — a negative needs the corpus count and the search over the same rows",
    guards: "D5 — looked-and-found-nothing, not blindness",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { ...READ_CORPUS, threadsRead: 1_486, unreadMail: 3 } },
    expected: "unknown",
  },
  {
    name: "A nomination past the confirm cap is an uncovered corpus, so the negative waits",
    decision: "ADR-0135 D5 amendment — a capped read stays unknown",
    guards: "D5 — the search must read every row it nominated",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: {
      ...RENDER_ABSENT,
      corpus: {
        ...READ_CORPUS,
        nominated: FOOTPRINT_CORPUS_CONFIRM_CAP + 1,
        mailsChecked: FOOTPRINT_CORPUS_CONFIRM_CAP,
      },
    },
    expected: "unknown",
  },
  {
    name: "A corpus with an unrepaired gmail history gap backs no negative",
    decision: "ADR-0135 D5 amendment — a gapped window stays unknown",
    guards: "D5 — the window is checked for unrepaired Gmail history gaps",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { ...READ_CORPUS, historyGapped: true } },
    expected: "unknown",
  },
  {
    name: "The D3 trap: a personal project named render on Railway matches no domain",
    decision: "ADR-0135 D3 — identity-keyed, never word-keyed",
    guards:
      "resolution.md — a name is not an identity; Alfred resolves a name to a thing before it acts",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: RENDER_ABSENT,
    expected: "not-in-footprint",
  },
  {
    name: "A ready MCP connection is connection evidence for a planned provider",
    decision: "ADR-0135 D3 — a connection endpoint is evidence",
    guards:
      "D2 — a sender list would demote a Railway incident the day Railway matters; connection truth does not",
    query: { slug: "railway", domains: ["railway.app", "railway.com"] },
    sight: {
      connections: {
        status: "hit",
        hits: [{ slug: "railway", account: "default", via: "mcp" }],
      },
      objects: NO_OBJECTS,
      corpus: READ_CORPUS,
    },
    expected: "in-footprint",
  },
  {
    name: "A loop ask keeps its weight: a GitHub advisory with GitHub connected is in the footprint",
    decision: "ADR-0135 D2 — loop asks keep today's weight unconditionally",
    guards: "D2 — the failed-deploy mail of ADR-0134 belongs to the loop class",
    query: { slug: "github", domains: ["github.com", "github.io"] },
    sight: {
      connections: {
        status: "hit",
        hits: [{ slug: "github", account: "yash@example.com", via: "credential" }],
      },
      objects: NO_OBJECTS,
      corpus: READ_CORPUS,
    },
    expected: "in-footprint",
  },
  {
    name: "An unconnected known provider with empty sight stays unknown, not negative",
    decision: "ADR-0135 D5 — positive sight demotes; an empty read under the floor does not",
    guards: "D1 — unknown keeps today's weight with softened wording",
    query: { slug: "sentry", domains: ["sentry.io"] },
    sight: {
      connections: NO_CONNECTIONS,
      objects: NO_OBJECTS,
      corpus: { ...READ_CORPUS, threadsRead: 40 },
    },
    expected: "unknown",
  },
  {
    name: "An unresolved identity: no domains and no slug is unknown, never a negative",
    decision: "ADR-0135 D3 — the fold answers only the identity it resolved",
    guards:
      "resolution.md — a negative without an identity answers a question the fold never asked",
    query: { slug: null, domains: [] },
    sight: RENDER_ABSENT,
    expected: "unknown",
  },
  {
    name: "A notice that names an owned object answers in the footprint at that granularity",
    decision: "ADR-0135 D5 amendment — notice scope: the fold answers at the named granularity",
    guards:
      "D5 amendment — the named keys come from the mail-to-object resolver triage already runs",
    query: { slug: "vercel", domains: ["vercel.com"], namedKeys: ["vcl_env_1"] },
    sight: {
      connections: {
        status: "hit",
        hits: [{ slug: "vercel", account: "yash@example.com", via: "credential" }],
      },
      objects: {
        status: "hit",
        hits: [
          {
            objectId: "iobj_env_1",
            provider: "vercel",
            kind: "environment",
            title: "Production env",
            url: null,
            matched: { via: "named-key", value: "vcl_env_1" },
          },
        ],
      },
      corpus: { status: "skipped", reason: "named-scope" },
    },
    expected: "in-footprint",
  },
  {
    name: "A notice that names a thing no owned object resolves to stays unknown, even connected",
    decision:
      "ADR-0135 D5 amendment — a provider connection alone cannot decide a notice that names one thing",
    guards:
      "D5 amendment — named keys that resolve to no owned object stay unknown, never a negative",
    query: { slug: "vercel", domains: ["vercel.com"], namedKeys: ["vcl_env_9"] },
    sight: {
      connections: {
        status: "hit",
        hits: [{ slug: "vercel", account: "yash@example.com", via: "credential" }],
      },
      objects: NO_OBJECTS,
      corpus: { status: "skipped", reason: "named-scope" },
    },
    expected: "unknown",
  },
];

interface CaseOutput {
  readonly verdict: FootprintVerdict;
  readonly evidenceKinds: readonly string[];
}

evalite<Case, CaseOutput, FootprintVerdict>("Footprint fold — ADR-0135 slice 1", {
  data: () => CASES.map((testCase) => ({ input: testCase, expected: testCase.expected })),
  task: async (testCase) => {
    const answer = foldFootprint(testCase.query, testCase.sight);

    return {
      verdict: answer.verdict,
      evidenceKinds: answer.evidence.map((item) => item.store),
    };
  },
  scorers: [
    {
      name: "The verdict is the state the stores back",
      scorer: ({ output, expected, input }) => ({
        score: output.verdict === expected ? 1 : 0,
        metadata: `${input.name}: verdict=${output.verdict}, expected=${expected}, evidence=[${output.evidenceKinds.join(", ")}]`,
      }),
    },
    {
      name: "The verdict carries its evidence",
      scorer: ({ output, input }) => {
        const kinds = output.evidenceKinds;

        const backed =
          output.verdict === "in-footprint"
            ? kinds.length > 0 && kinds.every((kind) => kind !== "corpus")
            : output.verdict === "not-in-footprint"
              ? kinds.length === 1 && kinds[0] === "corpus"
              : kinds.length === 0;

        return {
          score: backed ? 1 : 0,
          metadata: `${input.decision}; ${input.guards}; verdict=${output.verdict}, evidence=[${kinds.join(", ")}]`,
        };
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Object admission (D3), graded on its own
// ---------------------------------------------------------------------------

/**
 * The D3 admission rule, graded on its own: the reader may admit an object only through a
 * typed provider match or an identity host, and never through prose. The render-named
 * Railway project is the ADR's own example.
 */
interface AdmissionCase extends Guarded {
  readonly name: string;
  readonly args: Parameters<typeof admitsFootprintObject>[0];
  readonly expected: boolean;
  /** The matched domain the citation must carry, when the case admits. */
  readonly expectedDomain?: string;
}

const ADMISSION_CASES: readonly AdmissionCase[] = [
  {
    name: "The render-named Railway project admits nothing: its host is railway.com",
    decision: "ADR-0135 D3 — identity-keyed, never word-keyed",
    guards: "resolution.md — a name is not an identity; the prose title never enters",
    args: {
      slug: null,
      domains: ["render.com", "onrender.com"],
      row: {
        provider: "railway",
        identity: null,
        url: "https://railway.com/project/render",
      },
    },
    expected: false,
  },
  {
    name: "A service hosted on the provider's own domain admits its object",
    decision: "ADR-0135 D3 — the row's own URL is its identity",
    guards: "D3 — a connection endpoint, an object-state key or URL is evidence; prose is not",
    args: {
      slug: null,
      domains: ["render.com", "onrender.com"],
      row: {
        provider: "railway",
        identity: null,
        url: "https://alfred-api-staging.onrender.com/health",
      },
    },
    expected: true,
    expectedDomain: "onrender.com",
  },
  {
    name: "A typed key naming the provider's domain admits its object",
    decision: "ADR-0135 D3 — an identity value (a typed key's value) admits through its link host",
    guards: "D3 — object-state keys are typed, not word-matched",
    args: {
      slug: null,
      domains: ["render.com", "onrender.com"],
      row: {
        provider: "mcp",
        identity: "https://dashboard.render.com/project/prj_1234",
        url: null,
      },
    },
    expected: true,
    expectedDomain: "render.com",
  },
  {
    name: "A lookalike host is not the provider's domain",
    decision: "ADR-0135 D3 — the match is whole-label subdomains, never a substring",
    guards: "resolution.md — the word a broadcast repeats is not evidence",
    args: {
      slug: null,
      domains: ["render.com"],
      row: {
        provider: "mcp",
        identity: null,
        url: "https://render.commerce.io/status",
      },
    },
    expected: false,
  },
  {
    name: "A typed provider match admits without any URL",
    decision: "ADR-0135 D3 — the typed provider match is the reader's own admission",
    guards: "D3 — a provider's canonical identity form is its domain set",
    args: {
      slug: "railway",
      domains: ["railway.app"],
      row: { provider: "railway", identity: null, url: null },
    },
    expected: true,
  },
];

evalite<AdmissionCase, FootprintObjectMatch | null, boolean>(
  "Footprint object admission — ADR-0135 decision D3",
  {
    data: () =>
      ADMISSION_CASES.map((admissionCase) => ({
        input: admissionCase,
        expected: admissionCase.expected,
      })),
    task: async (admissionCase) => admitsFootprintObject(admissionCase.args),
    scorers: [
      {
        name: "The admission rule matches identity, never prose",
        scorer: ({ output, expected, input }) => ({
          score: (output !== null) === expected ? 1 : 0,
          metadata: `${input.name}: admitted=${String(output !== null)}, matched=${output ? JSON.stringify(output) : "null"}, expected=${String(expected)}`,
        }),
      },
      {
        name: "An admitted row cites the matched domain",
        scorer: ({ input, output }) => {
          if (input.expectedDomain === undefined) return { score: 1, metadata: "no domain asked" };

          const matched =
            output !== null && output.via === "identity" && output.domain === input.expectedDomain;

          return {
            score: matched ? 1 : 0,
            metadata: `${input.decision}: matched=${output ? JSON.stringify(output) : "null"}, expected domain=${input.expectedDomain}`,
          };
        },
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// The mail touch (the broadcast-sender rule), with the sender input the reader parses
// ---------------------------------------------------------------------------

/**
 * The broadcast-sender rule (D5 amendment), graded on its own. Every case gives the mail the
 * reader parses — the raw From header and the decoded text — and runs the reader's own path:
 * the sender domain out of `parseMailbox`, the link hosts out of `collectLinkParts`, then
 * `footprintMailTouch`. No case hands in a pre-matched hit.
 */
interface MailTouchCase extends Guarded {
  readonly name: string;
  /** The raw From header, or `null` when the header does not parse. */
  readonly from: string | null;
  /** The subject and the full decoded body, as the reader hands them to the touch. */
  readonly text: string;
  readonly domains: readonly string[];
  readonly expected: FootprintMailTouch | null;
}

const MAIL_TOUCH_CASES: readonly MailTouchCase[] = [
  {
    name: "The provider's own broadcast with its own link in the body is not use evidence",
    decision: "ADR-0135 D5 amendment — the broadcast-sender rule",
    guards:
      "D2 — the provider's own mail is the broadcast class itself and never proves its own relevance",
    from: "Render Security <security@render.com>",
    text: "Security notice: rotate your keys.\nhttps://render.com/security",
    domains: ["render.com", "onrender.com"],
    expected: null,
  },
  {
    name: "A Railway incident mail from the provider's own notify sender is the broadcast class",
    decision:
      "ADR-0135 D5 amendment — the broadcast-sender rule, subdomain sender included (notify.railway.app covers railway.app)",
    guards:
      "D2 — however many provider links it carries, the provider's own mail is not use evidence",
    from: "Railway <notify@notify.railway.app>",
    text: "[Railway] Deployment restarted\nhttps://railway.com/project/alfred/service/alfred-prod",
    domains: ["railway.app", "railway.com"],
    expected: null,
  },
  {
    name: "A person's mail linking the provider's domain is use evidence",
    decision: "ADR-0135 D5 amendment — an off-provider sender's touch counts",
    guards: "D5 amendment — the provider's domains in the body of an off-provider thread do count",
    from: "Sam Contractor <sam@example.test>",
    text: "Can you check the staging service?\nhttps://dashboard.render.com/p/prj_1",
    domains: ["render.com", "onrender.com"],
    expected: { via: "link", domain: "render.com" },
  },
  {
    name: "A person's mail linking a provider subdomain covers the base domain",
    decision:
      "ADR-0135 D5 amendment — the touch matches whole-label subdomains of the query domain",
    guards: "D3 — the provider's identity is its domain set, subdomains included",
    from: "Sam Contractor <sam@example.test>",
    text: "Deploy log from the incident:\nhttps://notify.railway.app/r/abc123",
    domains: ["railway.app", "railway.com"],
    expected: { via: "link", domain: "railway.app" },
  },
  {
    name: "A person's mail that only mentions the domain in prose is use evidence",
    decision: "ADR-0135 D5 amendment — a whole-label mention is identity, not prose",
    guards: "D3 — the token must be the domain or a subdomain of it, whole labels",
    from: "Sam Contractor <sam@example.test>",
    text: "Our render.com projects need the new key before Friday.",
    domains: ["render.com", "onrender.com"],
    expected: { via: "mention", domain: "render.com" },
  },
  {
    name: "A lookalike mention is not the provider's domain",
    decision: "ADR-0135 D3 — the comparison goes through the one domain match",
    guards: "resolution.md — render.commerce.io is not render.com",
    from: "Sam Contractor <sam@example.test>",
    text: "We moved the job to render.commerce.io last month.",
    domains: ["render.com"],
    expected: null,
  },
  {
    name: "A mail with no parseable sender that links the provider counts as use evidence",
    decision:
      "ADR-0135 D5 amendment — a null sender domain is not the provider's, so the body decides",
    guards: "D5 amendment — the broadcast rule rejects the sender, not the mail",
    from: null,
    text: "https://onrender.com/health",
    domains: ["render.com", "onrender.com"],
    expected: { via: "link", domain: "onrender.com" },
  },
];

evalite<MailTouchCase, MailTouchCase["expected"], boolean>(
  "Footprint mail touch — the broadcast-sender rule (D5 amendment)",
  {
    data: () =>
      MAIL_TOUCH_CASES.map((mailTouchCase) => ({
        input: mailTouchCase,
        expected: mailTouchCase.expected !== null,
      })),
    task: async (mailTouchCase) => {
      // The reader's own path: parse the sender off the raw header, collect the link hosts
      // out of the decoded text, then ask the touch.
      const senderDomain =
        mailTouchCase.from === null ? null : (parseMailbox(mailTouchCase.from)?.domain ?? null);

      const linkHosts = [...new Set(collectLinkParts(mailTouchCase.text).map(({ host }) => host))];

      return footprintMailTouch(
        { senderDomain, linkHosts, text: mailTouchCase.text },
        mailTouchCase.domains,
      );
    },
    scorers: [
      {
        name: "The touch matches the rule, via and domain both",
        scorer: ({ output, input }) => {
          const expected = input.expected;

          const sameShape =
            output === null
              ? expected === null
              : expected !== null &&
                output.via === expected.via &&
                output.domain === expected.domain;

          return {
            score: sameShape ? 1 : 0,
            metadata: `${input.name}: touch=${output ? JSON.stringify(output) : "null"}, expected=${expected ? JSON.stringify(expected) : "null"}`,
          };
        },
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// The reader, against real stored rows (D5's "real corpus cases")
// ---------------------------------------------------------------------------

/** The fixed read instant; every fixture window ends here. */
const FIXED_AT = new Date("2026-11-26T09:00:00Z");

/** Every fixture mail is authored inside the lookback window that ends at `FIXED_AT`. */
const MAIL_DATE = new Date("2026-11-20T09:00:00Z");

/** The filler corpus that makes a zero-hit window covered: over the measured floor, redacted. */
const FILLER_THREADS = FOOTPRINT_MIN_CORPUS_THREADS + 10;

/** The filler body names no provider domain, so only the seeded notice can nominate. */
const FILLER_BODY = "Archive thread: quarterly invoice round. Nothing pending on your side.";

async function seedFillerThreads(userId: string, count: number): Promise<void> {
  // In chunks of 50, because the measured floor makes the filler four figures and the
  // insert round-trips, not the rows, are the cost.
  for (let start = 0; start < count; start += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, count - start) }, (_, offset) => {
        const index = start + offset;

        return seedTriageThread(userId, {
          from: `Archive Sender ${index} <archive${index}@example.test>`,
          subject: `Quarterly archive thread ${index}`,
          body: FILLER_BODY,
          authoredAt: MAIL_DATE,
        });
      }),
    );
  }
}

/** The exact evidence shape a reader case must cite: the store, and the identity it matched. */
type ExpectedEvidence =
  | {
      readonly store: "corpus";
      readonly threadsRead: number;
      readonly unreadMail: number;
      readonly nominated: number;
      readonly mailsChecked: number;
      readonly lookbackDays: number;
    }
  | {
      readonly store: "mail";
      readonly matchedDomain: string;
      readonly via: "link" | "mention";
    }
  | {
      readonly store: "object";
      readonly via: FootprintObjectMatch["via"];
      readonly domain?: string;
      readonly value?: string;
    }
  | {
      readonly store: "connection";
      readonly via: "credential" | "mcp";
      readonly slug?: string;
    };

interface ReaderCase extends Guarded {
  /** Stable id: the throwaway user row, so a crashed run cannot double its rows. */
  readonly id: string;
  readonly name: string;
  readonly seed: (userId: string) => Promise<void>;
  readonly query: FootprintQuery;
  readonly expected: {
    readonly verdict: FootprintVerdict;
    readonly evidence: readonly ExpectedEvidence[];
  };
}

const READER_CASES: readonly ReaderCase[] = [
  {
    id: "render-negative",
    name: "The Render notice, replayed: months of stored mail with no mention is a confident negative",
    decision: "ADR-0135 D5 — the real corpus case of the measured fault: covered, read, empty",
    guards:
      "context-graph.md — the negative is an inference over what the stores hold today, recomputed (memory principle 5)",
    seed: (userId) => seedFillerThreads(userId, FILLER_THREADS),
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    expected: {
      verdict: "not-in-footprint",
      evidence: [
        {
          store: "corpus",
          threadsRead: FILLER_THREADS,
          unreadMail: 0,
          nominated: 0,
          mailsChecked: 0,
          lookbackDays: FOOTPRINT_LOOKBACK_DAYS,
        },
      ],
    },
  },
  {
    id: "render-mail-hit",
    name: "An off-provider stored mail that links the provider is cited, with the matched domain and via",
    decision:
      "ADR-0135 D5 amendment — the provider's domains in an off-provider thread's body count",
    guards: "D5 — each hit the corpus confirm step parsed is cited with its matched identity",
    seed: async (userId) => {
      await seedFillerThreads(userId, FILLER_THREADS);
      await seedTriageThread(userId, {
        from: "Sam Contractor <sam@example.test>",
        subject: "Staging handoff",
        body: "Handing over staging:\nhttps://dashboard.render.com/p/prj_9",
        authoredAt: MAIL_DATE,
      });
    },
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    expected: {
      verdict: "in-footprint",
      evidence: [{ store: "mail", matchedDomain: "render.com", via: "link" }],
    },
  },
  {
    id: "railway-own-notify",
    name: "The provider's own notify mail, replayed: read in full and rejected as the broadcast class",
    decision:
      "ADR-0135 D5 amendment — the broadcast-sender rule end to end: the reader parses the sender off the stored header",
    guards:
      "D2 — the notify.railway.app sender is the broadcast class; its railway.com links prove nothing",
    seed: async (userId) => {
      await seedFillerThreads(userId, FILLER_THREADS);
      await seedTriageThread(userId, {
        from: "Railway <notify@notify.railway.app>",
        subject: "[Railway] Deployment restarted",
        body: "Your deployment restarted.\nhttps://railway.com/project/alfred/service/alfred-prod",
        authoredAt: MAIL_DATE,
      });
    },
    query: { slug: "railway", domains: ["railway.app", "railway.com"] },
    expected: {
      verdict: "not-in-footprint",
      evidence: [
        {
          // The filler plus the notice's own stored mail: the reader read both.
          store: "corpus",
          threadsRead: FILLER_THREADS + 1,
          unreadMail: 0,
          nominated: 1,
          mailsChecked: 1,
          lookbackDays: FOOTPRINT_LOOKBACK_DAYS,
        },
      ],
    },
  },
  {
    id: "thin-corpus",
    name: "A window below the measured floor stays unknown, however clean its zero",
    decision:
      "ADR-0135 D5 amendment — the measured floor of 1,000 searchable threads (owner, 2026-11-26)",
    guards:
      "D5 — a few backfill days of clean mail do not back the negative; the corpus is thin, not empty",
    seed: (userId) => seedFillerThreads(userId, 20),
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    expected: { verdict: "unknown", evidence: [] },
  },
  {
    id: "unread-mail",
    name: "One triaged thread whose mail never arrived holds the negative, replayed",
    decision: "ADR-0135 D5 amendment — the corpus count and the search over the same rows",
    guards: "D5 — unreadMail is the blindness the fold must not call looked-and-found-nothing",
    seed: async (userId) => {
      await seedFillerThreads(userId, FILLER_THREADS);
      await seedTriageThread(userId, {
        from: "No Mail <nomail@example.test>",
        subject: "A thread whose stored mail was purged",
        body: FILLER_BODY,
        authoredAt: MAIL_DATE,
        storedMail: false,
      });
    },
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    expected: { verdict: "unknown", evidence: [] },
  },
  {
    id: "object-url",
    name: "An owned object whose own URL sits on the provider's domain is cited through that identity",
    decision: "ADR-0135 D3 — the row's own URL is its identity, admitted through the real reader",
    guards:
      "D3 — a connection endpoint, an object-state key or URL is evidence; the title never is",
    seed: (userId) =>
      seedObjectRow(userId, {
        provider: "mcp",
        kind: "project",
        externalId: "prj_9",
        url: "https://dashboard.render.com/project/prj_9",
        title: "Render project",
      }),
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    expected: {
      verdict: "in-footprint",
      evidence: [
        {
          store: "object",
          via: "identity",
          domain: "render.com",
          value: "https://dashboard.render.com/project/prj_9",
        },
      ],
    },
  },
  {
    id: "object-key",
    name: "A typed key naming the provider's domain admits its object through the keys join",
    decision: "ADR-0135 D3 — an identity value (a typed key's value) admits through its link host",
    guards: "D3 — object-state keys are typed, not word-matched",
    seed: (userId) =>
      seedObjectRow(userId, {
        provider: "mcp",
        kind: "project",
        externalId: "prj_1234",
        url: null,
        keys: [
          { keyKind: "dashboard_url", keyValue: "https://dashboard.render.com/project/prj_1234" },
        ],
      }),
    query: { slug: null, domains: ["render.com"] },
    expected: {
      verdict: "in-footprint",
      evidence: [
        {
          store: "object",
          via: "identity",
          domain: "render.com",
          value: "https://dashboard.render.com/project/prj_1234",
        },
      ],
    },
  },
  {
    id: "github-credential",
    name: "A connected GitHub App credential is connection evidence, replayed from the credential row",
    decision: "ADR-0135 D5 — connections are the first evidence store, live in prod",
    guards: "D2 — durable connection truth decides, never a sender list",
    seed: (userId) => seedGithubCredential(userId),
    query: { slug: "github", domains: ["github.com"] },
    expected: {
      verdict: "in-footprint",
      evidence: [{ store: "connection", via: "credential", slug: "github" }],
    },
  },
  {
    id: "railway-mcp-connection",
    name: "A ready MCP connection to the built-in endpoint is connection evidence for a planned provider",
    decision: "ADR-0135 D3 — a connection endpoint is evidence, replayed from the MCP rows",
    guards: "D2 — the only connection a planned provider such as Railway has is still evidence",
    seed: (userId) => seedRailwayMcpConnection(userId),
    query: { slug: "railway", domains: ["railway.app", "railway.com"] },
    expected: {
      verdict: "in-footprint",
      evidence: [{ store: "connection", via: "mcp", slug: "railway" }],
    },
  },
];

function evidenceItemMatches(
  output: FootprintAnswer["evidence"][number],
  want: ExpectedEvidence,
): boolean {
  if (output.store !== want.store) return false;

  switch (want.store) {
    case "corpus": {
      if (output.store !== "corpus") return false;

      return (
        output.threadsRead === want.threadsRead &&
        output.unreadMail === want.unreadMail &&
        output.nominated === want.nominated &&
        output.mailsChecked === want.mailsChecked &&
        output.lookbackDays === want.lookbackDays
      );
    }

    case "mail": {
      if (output.store !== "mail") return false;

      return output.hit.matchedDomain === want.matchedDomain && output.hit.via === want.via;
    }

    case "object": {
      if (output.store !== "object") return false;

      const matched = output.hit.matched;

      if (matched.via !== want.via) return false;

      if (
        want.domain !== undefined &&
        !(matched.via === "identity" && matched.domain === want.domain)
      ) {
        return false;
      }

      if (
        want.value !== undefined &&
        !(matched.via !== "provider" && matched.value === want.value)
      ) {
        return false;
      }

      return true;
    }

    case "connection": {
      if (output.store !== "connection") return false;

      return (
        output.hit.via === want.via && (want.slug === undefined || output.hit.slug === want.slug)
      );
    }
  }
}

function evidenceMatches(answer: FootprintAnswer, expected: readonly ExpectedEvidence[]): boolean {
  if (answer.evidence.length !== expected.length) return false;

  return expected.every((want, index) => {
    const got = answer.evidence[index];

    return got !== undefined && evidenceItemMatches(got, want);
  });
}

let readerTasksDone = 0;

evalite<ReaderCase, FootprintAnswer, ReaderCase>(
  "Footprint reader — stored rows through readFootprint (ADR-0135 D5)",
  {
    data: () => READER_CASES.map((readerCase) => ({ input: readerCase, expected: readerCase })),
    task: async (readerCase) => {
      const userId = await seedEvalUser(readerCase.id);

      try {
        await readerCase.seed(userId);

        return await readFootprint({ userId, query: readerCase.query, at: FIXED_AT });
      } finally {
        await deleteEvalUser(userId);

        // The last reader task closes the pool, so the run exits (the code-mode-paired way).
        readerTasksDone++;

        if (readerTasksDone === READER_CASES.length) await closeConnections();
      }
    },
    scorers: [
      {
        name: "The verdict is the state the stores back",
        scorer: ({ output, input }) => ({
          score: output.verdict === input.expected.verdict ? 1 : 0,
          metadata: `${input.name}: verdict=${output.verdict}, expected=${input.expected.verdict}`,
        }),
      },
      {
        name: "The evidence names the stores and the matched identities",
        scorer: ({ output, input }) => {
          const ok = evidenceMatches(output, input.expected.evidence);

          return {
            score: ok ? 1 : 0,
            metadata: [
              `${input.decision}; ${input.guards}`,
              `evidence=${JSON.stringify(output.evidence)}`,
              `expected=${JSON.stringify(input.expected.evidence)}`,
            ].join(" — "),
          };
        },
      },
    ],
  },
);
