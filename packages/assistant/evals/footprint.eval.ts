import { evalite } from "evalite";
import {
  admitsFootprintObject,
  foldFootprint,
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

/** The corpus leg of a confident negative: months of triaged mail, read and empty. */
const READ_CORPUS = { threadsRead: 1_486, lookbackDays: 90, hits: [] };

const NO_FAULTS: readonly never[] = [];

const RAILWAY_OWNED: FootprintSight = {
  connections: [],
  objects: [
    {
      objectId: "iobj_deploy_1",
      provider: "railway",
      kind: "deployment",
      title: "alfred production",
      url: "https://railway.com/project/alfred/service/alfred-prod",
    },
  ],
  corpus: READ_CORPUS,
  faults: NO_FAULTS,
};

const RENDER_ABSENT: FootprintSight = {
  connections: [],
  objects: [],
  corpus: READ_CORPUS,
  faults: NO_FAULTS,
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
    sight: { ...RENDER_ABSENT, faults: ["corpus"] },
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
      objects: [],
      corpus: {
        ...READ_CORPUS,
        hits: [
          {
            documentId: "doc_incident",
            threadId: "thread_incident",
            matchedDomain: "railway.app",
          },
        ],
      },
    },
    expected: "in-footprint",
  },
  {
    name: "A loop ask keeps its weight: a GitHub advisory with GitHub connected is in the footprint",
    query: { slug: "github", domains: ["github.com", "github.io"] },
    sight: {
      connections: [{ slug: "github", account: "yash@example.com" }],
      objects: [],
      corpus: READ_CORPUS,
      faults: NO_FAULTS,
    },
    expected: "in-footprint",
  },
  {
    name: "An unconnected known provider with empty sight stays unknown, not negative",
    query: { slug: "sentry", domains: ["sentry.io"] },
    sight: {
      connections: [],
      objects: [],
      corpus: { ...READ_CORPUS, threadsRead: 40 },
      faults: NO_FAULTS,
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
          metadata: `verdict=${output.verdict}, evidence=[${output.evidenceKinds.join(", ")}]`,
        };
      },
    },
  ],
});

evalite<AdmissionCase, boolean, boolean>("Footprint object admission — ADR-0135 decision D3", {
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
        score: output === expected ? 1 : 0,
        metadata: `admitted=${String(output)}, expected=${String(expected)}`,
      }),
    },
  ],
});
