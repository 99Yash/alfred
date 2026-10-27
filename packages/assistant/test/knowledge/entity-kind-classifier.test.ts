import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { identityRefSchema, type IdentityRef } from "@alfred/contracts";
import { classifyEntityKind } from "@alfred/assistant/knowledge/entity-kind-classifier";

describe("classifyEntityKind", () => {
  test("uses List-Id as authoritative group evidence", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("engineering@oliv.ai"),
      displayNames: ["Anthropic via Engineering"],
      payloadSignals: [{ listId: "Engineering <engineering.oliv.ai>" }],
    });

    assert.equal(result.kind, "group");
    assert.equal(result.confidence, 0.99);
    assert.deepEqual(result.evidenceCodes, ["gmail:list_id"]);
  });

  test("uses bulk/list precedence and List-Unsubscribe as authoritative group evidence", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("updates@example.com"),
      payloadSignals: [{ precedence: "bulk", listUnsubscribe: "<mailto:off@example.com>" }],
    });

    assert.equal(result.kind, "group");
    assert.equal(result.confidence, 0.99);
    assert.deepEqual(result.evidenceCodes, ["gmail:list_unsubscribe", "gmail:precedence:bulk"]);
  });

  test("classifies no-reply and notification senders as services", () => {
    assert.equal(
      classifyEntityKind({ identity: emailIdentity("noreply@github.com") }).kind,
      "service",
    );
    assert.equal(
      classifyEntityKind({ identity: emailIdentity("notifications@tasks.clickup.com") }).kind,
      "service",
    );
  });

  test("keeps a human-looking mailbox on a service domain as a person", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("jane.doe@google.com"),
      displayNames: ["Jane Doe"],
    });

    assert.equal(result.kind, "person");
    assert.deepEqual(result.evidenceCodes, ["display:person_like"]);
  });

  test("does not classify a bare human-looking service-domain mailbox as service", () => {
    const result = classifyEntityKind({ identity: emailIdentity("jane.doe@google.com") });

    assert.equal(result.kind, "person");
    assert.deepEqual(result.evidenceCodes, ["email:local:person_like"]);
  });

  test("keeps domain-only service evidence below the triage demotion bar", () => {
    const result = classifyEntityKind({ identity: emailIdentity("inbox@google.com") });

    assert.equal(result.kind, "unknown");
    assert.equal(result.bestGuess, "service");
    assert.deepEqual(result.evidenceCodes, ["email:domain:service_weak"]);
    assert.ok(result.confidence < 0.8);
  });

  test("does not person-score weak group aliases without header evidence", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("team@startup.example"),
      displayNames: ["Team"],
    });

    assert.equal(result.kind, "unknown");
    assert.equal(result.bestGuess, "group");
    assert.ok(result.confidence < 0.7);
    assert.deepEqual(result.evidenceCodes, ["email:local:group_weak"]);
  });

  test("checks compound group aliases before person-like local parts", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("engineering-team@startup.example"),
    });

    assert.equal(result.kind, "unknown");
    assert.equal(result.bestGuess, "group");
    assert.deepEqual(result.evidenceCodes, ["email:local:group_weak"]);
  });

  test("classifies plain individual mailboxes as people", () => {
    const result = classifyEntityKind({
      identity: emailIdentity("alice@example.com"),
      displayNames: ["Alice Example"],
    });

    assert.equal(result.kind, "person");
    assert.equal(result.confidence, 0.82);
  });

  test("classifies non-email hard identities by their identity kind", () => {
    assert.equal(classifyEntityKind({ identity: domainIdentity("oliv.ai") }).kind, "organization");
    assert.equal(
      classifyEntityKind({ identity: identity("github_repository_full_name", "99yash/alfred") })
        .kind,
      "repository",
    );
  });

  test("reads the kind segment of an integration_object_key, not the identity kind", () => {
    // Two node kinds anchor on `integration_object_key`, so the identity kind alone is not enough.
    const referent = classifyEntityKind({
      identity: identity("integration_object_key", "github:pull_request:99yash/alfred#913"),
    });

    assert.equal(referent.kind, "referent");
    assert.deepEqual(referent.evidenceCodes, ["identity:integration_object_key:pull_request"]);

    const senderScoped = classifyEntityKind({
      identity: identity(
        "integration_object_key",
        "alfred:referent:ent_aaaa/baserow-response-time",
      ),
    });

    assert.equal(senderScoped.kind, "referent");

    const project = classifyEntityKind({
      identity: identity("integration_object_key", "clickup:project:901234"),
    });

    assert.equal(project.kind, "project");
  });

  test("an unregistered kind segment is unknown with a guess, never a guessed kind", () => {
    const result = classifyEntityKind({
      identity: identity("integration_object_key", "vercel:deployment:dpl_abc"),
    });

    assert.equal(result.kind, "unknown");
    assert.equal(result.bestGuess, "project");
    assert.deepEqual(result.evidenceCodes, ["identity:integration_object_key:unregistered"]);
  });
});

function emailIdentity(value: string): IdentityRef {
  return identity("email", value.toLowerCase());
}

function domainIdentity(value: string): IdentityRef {
  return identity("domain", value.toLowerCase());
}

function identity(kind: IdentityRef["kind"], value: string): IdentityRef {
  return identityRefSchema.parse({ kind, value });
}
