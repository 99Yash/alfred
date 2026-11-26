import { evalite } from "evalite";
import {
  admitsFootprintObject,
  foldFootprint,
  footprintMailTouch,
  type FootprintCorpusLeg,
  type FootprintLeg,
  type FootprintMailTouch,
  type FootprintObjectMatch,
  type FootprintQuery,
  type FootprintSight,
  type FootprintVerdict,
} from "@alfred/assistant/knowledge/footprint";

/**
 * The ADR-0135 eval deck, slice 1: it grades the pure footprint fold against the sight
 * snapshots that the real stores would hand it, before the composer ever reads the verdict
 * (decision D5). The deck runs with no database and no model, so it is cheap enough to run
 * on every touch of the fold.
 *
 * The first case is the ADR's named worst error: a broadcast that does touch the owner's
 * world demoted to a passing line. The Render case is the measured fault that produced the
 * ADR (2026-11-26). Run it alone:
 * `pnpm --filter @alfred/assistant exec evalite run footprint`.
 */

interface Case {
  readonly name: string;
  readonly query: FootprintQuery;
  readonly sight: FootprintSight;
  readonly expected: FootprintVerdict;
}

/** The corpus leg of a confident negative: months of triaged mail, read in full and empty. */
const READ_CORPUS: FootprintCorpusLeg = {
  status: "read",
  lookbackDays: 90,
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
    query: { slug: "railway", domains: ["railway.app", "railway.com"] },
    sight: RAILWAY_OWNED,
    expected: "in-footprint",
  },
  {
    name: "The Render notice: no connection, no object, months of mail with no mention",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: RENDER_ABSENT,
    expected: "not-in-footprint",
  },
  {
    name: "Thin sight: a corpus the fold could barely see stays unknown",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { ...READ_CORPUS, threadsRead: 12 } },
    expected: "unknown",
  },
  {
    name: "A faulted corpus leg never backs a negative",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { status: "unreadable" } },
    expected: "unknown",
  },
  {
    name: "Triaged threads whose mail never arrived are not corpus sight",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { ...READ_CORPUS, threadsRead: 1_486, unreadMail: 3 } },
    expected: "unknown",
  },
  {
    name: "A nomination past the confirm cap is an uncovered corpus, so the negative waits",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: {
      ...RENDER_ABSENT,
      corpus: { ...READ_CORPUS, nominated: 26, mailsChecked: 25 },
    },
    expected: "unknown",
  },
  {
    name: "A corpus with an unrepaired gmail history gap backs no negative",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: { ...RENDER_ABSENT, corpus: { ...READ_CORPUS, historyGapped: true } },
    expected: "unknown",
  },
  {
    name: "The D3 trap: a personal project named render on Railway matches no domain",
    query: { slug: null, domains: ["render.com", "onrender.com"] },
    sight: RENDER_ABSENT,
    expected: "not-in-footprint",
  },
  {
    name: "A notify.railway.app sender covers the railway.app base domain",
    query: { slug: "railway", domains: ["railway.app", "railway.com"] },
    sight: {
      ...RAILWAY_OWNED,
      objects: NO_OBJECTS,
      corpus: {
        ...READ_CORPUS,
        hits: [
          {
            documentId: "doc_incident",
            threadId: "thread_incident",
            matchedDomain: "railway.app",
            via: "link",
          },
        ],
      },
    },
    expected: "in-footprint",
  },
  {
    name: "A ready MCP connection is connection evidence for a planned provider",
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
    query: { slug: null, domains: [] },
    sight: RENDER_ABSENT,
    expected: "unknown",
  },
  {
    name: "A notice that names an owned object answers in the footprint at that granularity",
    query: { slug: "prisma", domains: ["prisma.io"], namedKeys: ["accelerate_env_1"] },
    sight: {
      connections: {
        status: "hit",
        hits: [{ slug: "prisma", account: "yash@example.com", via: "credential" }],
      },
      objects: {
        status: "hit",
        hits: [
          {
            objectId: "iobj_env_1",
            provider: "prisma",
            kind: "environment",
            title: "Accelerate env",
            url: null,
            matched: { via: "named-key", value: "accelerate_env_1" },
          },
        ],
      },
      corpus: { status: "skipped", reason: "named-scope" },
    },
    expected: "in-footprint",
  },
  {
    name: "A notice that names a thing no owned object resolves to stays unknown, even connected",
    query: { slug: "prisma", domains: ["prisma.io"], namedKeys: ["accelerate_env_9"] },
    sight: {
      connections: {
        status: "hit",
        hits: [{ slug: "prisma", account: "yash@example.com", via: "credential" }],
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

/**
 * The D3 admission rule, graded on its own: the reader may admit an object only through a
 * typed provider match or an identity host, and never through prose. The render-named
 * Railway project is the ADR's own example.
 */
interface AdmissionCase {
  readonly name: string;
  readonly args: Parameters<typeof admitsFootprintObject>[0];
  readonly expected: boolean;
  /** The matched domain the citation must carry, when the case admits. */
  readonly expectedDomain?: string;
}

const ADMISSION_CASES: readonly AdmissionCase[] = [
  {
    name: "The render-named Railway project admits nothing: its host is railway.com",
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
    args: {
      slug: "railway",
      domains: ["railway.app"],
      row: { provider: "railway", identity: null, url: null },
    },
    expected: true,
  },
];

/**
 * The broadcast-sender rule (D5 amendment), graded on its own: the provider's own mail is
 * the broadcast class itself and never proves its own relevance, however many provider
 * links it carries. A person's or a third party's mail touching the provider's domains is
 * the evidence.
 */
interface MailTouchCase {
  readonly name: string;
  readonly mail: Parameters<typeof footprintMailTouch>[0];
  readonly domains: readonly string[];
  readonly expected: FootprintMailTouch | null;
}

const MAIL_TOUCH_CASES: readonly MailTouchCase[] = [
  {
    name: "The provider's own broadcast with its own link in the body is not use evidence",
    mail: {
      senderDomain: "render.com",
      linkHosts: ["render.com", "updates.onrender.com"],
      text: "Security notice: rotate your keys.\nhttps://render.com/security",
    },
    domains: ["render.com", "onrender.com"],
    expected: null,
  },
  {
    name: "A person's mail linking the provider's domain is use evidence",
    mail: {
      senderDomain: "example.com",
      linkHosts: ["dashboard.render.com"],
      text: "Can you check the staging service?\nhttps://dashboard.render.com/p/prj_1",
    },
    domains: ["render.com", "onrender.com"],
    expected: { via: "link", domain: "render.com" },
  },
  {
    name: "A person's mail that only mentions the domain in prose is use evidence",
    mail: {
      senderDomain: "example.com",
      linkHosts: [],
      text: "Our render.com projects need the new key before Friday.",
    },
    domains: ["render.com", "onrender.com"],
    expected: { via: "mention", domain: "render.com" },
  },
  {
    name: "A lookalike mention is not the provider's domain",
    mail: {
      senderDomain: "example.com",
      linkHosts: [],
      text: "We moved the job to render.commerce.io last month.",
    },
    domains: ["render.com"],
    expected: null,
  },
  {
    name: "A mail with no parseable sender that links the provider counts as use evidence",
    mail: {
      senderDomain: null,
      linkHosts: ["onrender.com"],
      text: "",
    },
    domains: ["render.com", "onrender.com"],
    expected: { via: "link", domain: "onrender.com" },
  },
];

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
      scorer: ({ output, expected }) => ({
        score: output.verdict === expected ? 1 : 0,
        metadata: `verdict=${output.verdict}, expected=${expected}, evidence=[${output.evidenceKinds.join(", ")}]`,
      }),
    },
    {
      name: "The verdict carries its evidence",
      scorer: ({ output }) => {
        const kinds = output.evidenceKinds;

        const backed =
          output.verdict === "in-footprint"
            ? kinds.length > 0 && kinds.every((kind) => kind !== "corpus")
            : output.verdict === "not-in-footprint"
              ? kinds.length === 1 && kinds[0] === "corpus"
              : kinds.length === 0;

        return {
          score: backed ? 1 : 0,
          metadata: `verdict=${output.verdict}, evidence=[${kinds.join(", ")}]`,
        };
      },
    },
  ],
});

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
        scorer: ({ output, expected }) => ({
          score: (output !== null) === expected ? 1 : 0,
          metadata: `admitted=${String(output !== null)}, matched=${output ? JSON.stringify(output) : "null"}, expected=${String(expected)}`,
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
            metadata: `matched=${output ? JSON.stringify(output) : "null"}, expected domain=${input.expectedDomain}`,
          };
        },
      },
    ],
  },
);

evalite<MailTouchCase, MailTouchCase["expected"], boolean>(
  "Footprint mail touch — the broadcast-sender rule (D5 amendment)",
  {
    data: () =>
      MAIL_TOUCH_CASES.map((mailTouchCase) => ({
        input: mailTouchCase,
        expected: mailTouchCase.expected !== null,
      })),
    task: async (mailTouchCase) => footprintMailTouch(mailTouchCase.mail, mailTouchCase.domains),
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
            metadata: `touch=${output ? JSON.stringify(output) : "null"}, expected=${expected ? JSON.stringify(expected) : "null"}`,
          };
        },
      },
    ],
  },
);
