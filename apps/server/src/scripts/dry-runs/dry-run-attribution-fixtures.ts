import { toMessage } from "@alfred/contracts";
/**
 * Read-only fixtures for rule 16a (ii): an action assigned to a named third party
 * must not mint a todo for the user. A positive control checks a real ask still does.
 */
import {
  assembleObservations,
  classifyEmail,
  extractSenderContext,
  resolveTodoSuggestion,
} from "@alfred/assistant/triage";

const IDENTITY = { name: "Yash Kar", email: "yash.k@oliv.ai" };

// `expectTodo`: would `resolveTodoSuggestion` mint a todo? `expect` is the printed reason.
const FIXTURES: Array<{
  label: string;
  expect: string;
  expectTodo: boolean;
  from: string;
  to: string;
  subject: string;
  body: string;
}> = [
  {
    label: "Sakshi standup (third-party owner)",
    expect: "no todo (owned by Sakshi)",
    expectTodo: false,
    from: "Oliv AI <notifications@tasks.clickup.com>",
    to: "yash.k@oliv.ai",
    subject: "Engineering standup",
    body: "@Yash Kar heads up for today's engineering standup: Sakshi Jindal is tagged to run the standup as dvd is out for a hospital run. Agenda is in the doc.",
  },
  {
    label: "@alice review request (third-party owner)",
    expect: "no todo (owned by alice)",
    expectTodo: false,
    from: "GitHub <notifications@github.com>",
    to: "yash.k@oliv.ai",
    subject: "Re: PR #42",
    body: "On PR #42: @alice please review the migration changes and approve before we merge. Thanks!",
  },
  {
    label: "positive control — direct ask of the user",
    expect: "todo (Yash owes the SOW)",
    expectTodo: true,
    from: "Priya Sharma <priya@client.com>",
    to: "yash.k@oliv.ai",
    subject: "SOW",
    body: "Hi Yash, the order shipped. Separately — please send me the signed SOW by Friday so we can kick off. Thanks!",
  },
];

async function main() {
  let failures = 0;

  for (const f of FIXTURES) {
    const content = `From: ${f.from}\nTo: ${f.to}\nSubject: ${f.subject}\n\n${f.body}`;

    const scResult = extractSenderContext({
      fromHeader: f.from,
      subject: f.subject,
      body: content,
    });

    const observations = assembleObservations({
      senderKey: null,
      senderPrior: null,
      persona: "work",
      thread: { lastUserReplyAt: null, newestDirection: null, messageCount: 0, recentMessages: [] },
      knownContact: false,
      senderRelationship: null,
      senderKind: null,
      labelIds: [],
      signalText: [f.from, f.to, f.subject, content].join("\n"),
    });

    const { classification } = await classifyEmail({
      document: {
        id: "fixture",
        title: f.subject,
        content,
        authoredAt: null,
        metadata: { from: f.from, to: f.to },
      },
      senderContext: scResult.context,
      observations,
      identity: IDENTITY,
    });

    const d = classification.todoDecision;
    // Check what prod would mint, not the raw suggestion. The anchor is null
    // because these fixtures have no `authoredAt`, as in prod.
    const resolved = resolveTodoSuggestion(classification, null);
    const todo = resolved?.name ?? null;
    const gotTodo = resolved !== null;
    const ok = gotTodo === f.expectTodo;

    if (!ok) failures++;
    console.log(`\n${ok ? "PASS" : "FAIL"} ${f.label}\n  expect: ${f.expect}`);
    console.log(
      `  → cat=${classification.category} | outcome=${d?.outcome ?? "(none)"}${d?.note ? ` (${d.note})` : ""}`,
    );
    console.log(
      `  → todo: ${todo ? `"${todo}"` : "NONE"} (expected ${f.expectTodo ? "a todo" : "NONE"})`,
    );
  }

  console.log(`\n# ${FIXTURES.length - failures}/${FIXTURES.length} fixtures passed`);

  if (failures > 0) {
    throw new Error(`${failures} attribution fixture(s) did not match the expected gate outcome`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exit(1);
  });
