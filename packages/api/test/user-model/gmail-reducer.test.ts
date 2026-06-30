import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  gmailEmailMessagePayloadSchema,
  observationInsertSchema,
  type ObservationInsert,
  type ObservationInsertInput,
} from "@alfred/contracts";
import {
  reduceGmailDocument,
  type GmailDocumentForReduction,
} from "../../src/modules/user-model/gmail-reducer";

const AUTHORED_AT = new Date("2026-06-30T08:00:00.000Z");

describe("reduceGmailDocument", () => {
  test("reduces an inbound Gmail document into one validated email observation", () => {
    const result = reduceGmailDocument(
      gmailDoc({
        headers: [
          ["From", "Alice Example <Alice@Example.com>"],
          ["To", "Yash <yash@example.com>"],
          ["Cc", '"Doe, Jane" <Jane.Doe@Example.com>'],
          ["Subject", "Project update"],
          ["Message-Id", "<m1@example.com>"],
          ["List-Id", "Engineering <engineering.example.com>"],
          ["References", "<root@example.com> <prev@example.com>"],
        ],
        metadata: { isSent: false },
      }),
    );

    assert.deepEqual(result.issues, []);
    const observation = onlyObservation(result.observations);
    assert.doesNotThrow(() => observationInsertSchema.parse(observation));
    assert.equal(observation.source, "gmail");
    assert.equal(observation.kind, "email_message");
    assert.equal(observation.familyKey, "gmail:message:acct_1:gmail_msg_1");
    assert.equal(emailSubjectValue(observation), "alice@example.com");
    assert.equal(observation.objectIdentity, null);
    assert.equal(observation.participants.recipientCount, 2);
    assert.equal(observation.participants.listId, "Engineering <engineering.example.com>");
    assert.deepEqual(
      observation.participants.items.map((p) => [p.role, p.identity.value, p.displayName ?? null]),
      [
        ["from", "alice@example.com", "Alice Example"],
        ["to", "yash@example.com", "Yash"],
        ["cc", "jane.doe@example.com", "Doe, Jane"],
      ],
    );
    assert.match(observation.evidenceHash, /^sha256:[a-f0-9]{64}$/);
    const payload = gmailEmailMessagePayloadSchema.parse(observation.payload);
    assert.deepEqual(payload, {
      provider: "gmail",
      documentId: "doc_1",
      messageId: "gmail_msg_1",
      threadId: "gmail_thread_1",
      accountId: "acct_1",
      isSent: false,
      subject: "Project update",
      subjectHash: payload.subjectHash,
      headers: {
        messageId: "<m1@example.com>",
        inReplyTo: null,
        references: ["<root@example.com>", "<prev@example.com>"],
        listId: "Engineering <engineering.example.com>",
        replyTo: null,
        deliveredTo: null,
        autoSubmitted: null,
        precedence: null,
      },
    });
    assert.match(String(payload.subjectHash), /^sha256:[a-f0-9]{64}$/);
  });

  test("uses sent From as the subject identity and reads SENT from raw labels", () => {
    const result = reduceGmailDocument(
      gmailDoc({
        sourceId: "gmail_msg_sent",
        headers: [
          ["From", "Yash <YASH@Example.com>"],
          ["To", "Alice <alice@example.com>"],
          ["Subject", "Re: Project update"],
        ],
        labelIds: ["SENT"],
        metadata: { isSent: false },
      }),
    );

    const observation = onlyObservation(result.observations);
    assert.equal(emailSubjectValue(observation), "yash@example.com");
    assert.equal(observation.participants.recipientCount, 1);
    assert.equal(gmailEmailMessagePayloadSchema.parse(observation.payload).isSent, true);
  });

  test("counts distinct recipient identities once across To/Cc", () => {
    const result = reduceGmailDocument(
      gmailDoc({
        headers: [
          ["From", "Sender <sender@example.com>"],
          ["To", "Alice <alice@example.com>"],
          ["Cc", "Alice Again <ALICE@example.com>, Bob <bob@example.com>"],
        ],
      }),
    );

    const observation = onlyObservation(result.observations);
    assert.equal(observation.participants.recipientCount, 2);
    assert.deepEqual(
      observation.participants.items.map((p) => [p.role, p.identity.value]),
      [
        ["from", "sender@example.com"],
        ["to", "alice@example.com"],
        ["cc", "alice@example.com"],
        ["cc", "bob@example.com"],
      ],
    );
  });

  test("falls back to metadata headers and raw internalDate", () => {
    const result = reduceGmailDocument(
      gmailDoc({
        authoredAt: null,
        internalDate: "1782806400000",
        rawPayloadHeaders: [],
        metadata: {
          from: "Meta Sender <meta@example.com>",
          to: "Receiver <receiver@example.com>",
          isSent: true,
        },
      }),
    );

    const observation = onlyObservation(result.observations);
    assert.equal(observation.occurredAt.toISOString(), "2026-06-30T08:00:00.000Z");
    assert.equal(emailSubjectValue(observation), "meta@example.com");
    assert.equal(gmailEmailMessagePayloadSchema.parse(observation.payload).isSent, true);
  });

  test("skips documents without a parseable sender", () => {
    const result = reduceGmailDocument(
      gmailDoc({
        headers: [
          ["From", "Not An Address"],
          ["To", "Receiver <receiver@example.com>"],
        ],
      }),
    );

    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.issues, [
      {
        documentId: "doc_1",
        severity: "skip",
        code: "missing_sender",
        message: "Gmail document has no parseable From header",
      },
    ]);
  });

  test("warns but keeps the observation when some recipients are unparseable", () => {
    const result = reduceGmailDocument(
      gmailDoc({
        headers: [
          ["From", "Sender <sender@example.com>"],
          ["To", "bad recipient, Good <good@example.com>"],
        ],
      }),
    );

    const observation = onlyObservation(result.observations);
    assert.equal(observation.participants.recipientCount, 1);
    assert.deepEqual(result.issues, [
      {
        documentId: "doc_1",
        severity: "warn",
        code: "dropped_unparseable_recipient",
        message: "Dropped 1 unparseable recipient address(es)",
      },
    ]);
  });
});

function onlyObservation(observations: readonly ObservationInsertInput[]): ObservationInsert {
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.ok(observation);
  return observationInsertSchema.parse(observation);
}

function emailSubjectValue(observation: ObservationInsert): string {
  assert.equal(observation.subjectIdentity.kind, "email");
  if (observation.subjectIdentity.kind !== "email") {
    throw new Error("expected email subject identity");
  }
  return observation.subjectIdentity.value;
}

function gmailDoc(
  overrides: {
    sourceId?: string;
    sourceThreadId?: string | null;
    accountId?: string | null;
    title?: string | null;
    authoredAt?: Date | null;
    headers?: readonly (readonly [string, string])[];
    rawPayloadHeaders?: readonly (readonly [string, string])[];
    labelIds?: string[];
    internalDate?: string;
    metadata?: unknown;
  } = {},
): GmailDocumentForReduction {
  const headers = overrides.headers ?? [
    ["From", "Alice <alice@example.com>"],
    ["To", "Yash <yash@example.com>"],
  ];
  const rawHeaders = overrides.rawPayloadHeaders ?? headers;
  return {
    id: "doc_1",
    userId: "usr_1",
    sourceId: overrides.sourceId ?? "gmail_msg_1",
    sourceThreadId: overrides.sourceThreadId ?? "gmail_thread_1",
    accountId: overrides.accountId ?? "acct_1",
    title: overrides.title ?? "Fallback title",
    authoredAt: overrides.authoredAt === undefined ? AUTHORED_AT : overrides.authoredAt,
    raw: {
      id: overrides.sourceId ?? "gmail_msg_1",
      threadId: overrides.sourceThreadId ?? "gmail_thread_1",
      labelIds: overrides.labelIds ?? [],
      internalDate: overrides.internalDate ?? String(AUTHORED_AT.getTime()),
      payload: {
        headers: rawHeaders.map(([name, value]) => ({ name, value })),
      },
    },
    metadata: overrides.metadata ?? {
      from: headerValue(headers, "From"),
      to: headerValue(headers, "To"),
      cc: headerValue(headers, "Cc"),
      isSent: overrides.labelIds?.includes("SENT") ?? false,
    },
  };
}

function headerValue(headers: readonly (readonly [string, string])[], name: string): string | null {
  const match = headers.find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return match?.[1] ?? null;
}
