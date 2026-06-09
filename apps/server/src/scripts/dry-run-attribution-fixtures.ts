/**
 * Attribution-gate fixtures (ADR-0050/0051 amendment 2026-06-09) — READ-ONLY.
 * Validates rule 16a (ii): an action the email assigns to a named third party
 * must NOT mint a todo for the user. Plus a positive control (a real ask of the
 * user must still propose). No DB writes to todos/triage.
 */
import { assembleObservations, classifyEmail, extractSenderContext } from "@alfred/api";

const IDENTITY = { name: "Yash Kar", email: "yash.k@oliv.ai" };

const FIXTURES: Array<{ label: string; expect: string; from: string; to: string; subject: string; body: string }> = [
  {
    label: "Sakshi standup (third-party owner)",
    expect: "no todo (owned by Sakshi)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    to: "yash.k@oliv.ai",
    subject: "Engineering standup",
    body: "@Yash Kar heads up for today's engineering standup: Sakshi Jindal is tagged to run the standup as dvd is out for a hospital run. Agenda is in the doc.",
  },
  {
    label: "@alice review request (third-party owner)",
    expect: "no todo (owned by alice)",
    from: "GitHub <notifications@github.com>",
    to: "yash.k@oliv.ai",
    subject: "Re: PR #42",
    body: "On PR #42: @alice please review the migration changes and approve before we merge. Thanks!",
  },
  {
    label: "positive control — direct ask of the user",
    expect: "todo (Yash owes the SOW)",
    from: "Priya Sharma <priya@client.com>",
    to: "yash.k@oliv.ai",
    subject: "SOW",
    body: "Hi Yash, the order shipped. Separately — please send me the signed SOW by Friday so we can kick off. Thanks!",
  },
];

async function main() {
  for (const f of FIXTURES) {
    const content = `From: ${f.from}\nTo: ${f.to}\nSubject: ${f.subject}\n\n${f.body}`;
    const scResult = extractSenderContext({ fromHeader: f.from, subject: f.subject, body: content });
    const observations = assembleObservations({
      senderKey: null,
      senderPrior: null,
      persona: "work",
      thread: { lastUserReplyAt: null, newestDirection: null, messageCount: 0 },
      knownContact: false,
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
    const todo = classification.todoSuggestion?.name ?? null;
    console.log(`\n${f.label}\n  expect: ${f.expect}`);
    console.log(`  → cat=${classification.category} | outcome=${d?.outcome ?? "(none)"}${d?.note ? ` (${d.note})` : ""}`);
    console.log(`  → todo: ${todo ? `"${todo}"` : "NONE"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
