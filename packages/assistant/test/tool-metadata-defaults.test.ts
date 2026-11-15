import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { z } from "zod";

import { deriveToolDiscovery } from "../src/tool-runtime/internal/metadata-defaults";

describe("deriveToolDiscovery", () => {
  test("derives a searchable baseline from identity, action, and schema fields", () => {
    const discovery = deriveToolDiscovery({
      integration: "system",
      action: "create_artifact",
      description: "Create an artifact under an organizer.",
      inputSchema: z
        .object({
          title: z.string(),
          organizerId: z.string(),
          content: z.string(),
          pageToken: z.string().optional(),
        })
        .strict(),
    });

    assert.equal(discovery.title, "Create Artifact", "title defaults to the humanized action");
    assert.equal(
      discovery.summary,
      "Create an artifact under an organizer.",
      "summary defaults to the description",
    );
    assert.ok(discovery.tags?.includes("system"), "the server identity becomes a tag");
    assert.ok(discovery.verbs?.includes("create"), "the leading action token is a verb");
    assert.ok(discovery.verbs?.includes("add"), "generic verb synonyms improve recall");
    assert.ok(discovery.entities?.includes("artifact"), "trailing action tokens are entities");
    assert.ok(
      discovery.entities?.includes("title") && discovery.entities.includes("content"),
      "meaningful schema field names become entities",
    );
    assert.ok(discovery.entities?.includes("organizer"), "camelCase fields split into noun tokens");
    assert.ok(
      !discovery.entities?.includes("id") && !discovery.entities?.includes("pagetoken"),
      "plumbing field tokens are excluded",
    );
    assert.ok(
      discovery.aliases?.includes("create artifact") &&
        discovery.aliases.includes("system create artifact"),
      "aliases map likely phrasings onto the capability",
    );
    assert.equal(discovery.relatedTools, undefined, "relatedTools is authored-only");
  });

  test("singularizes entities so a query matches either number", () => {
    const discovery = deriveToolDiscovery({
      integration: "vercel",
      action: "list_deployments",
      description: "List deployments.",
      inputSchema: z.object({}).strict(),
    });

    assert.ok(discovery.entities?.includes("deployment"), "plural action noun is singularized");
    assert.ok(discovery.entities?.includes("deployments"), "the original plural is kept too");
  });

  test("merges hand-authored overrides on top of the derived baseline", () => {
    const discovery = deriveToolDiscovery({
      integration: "sheets",
      action: "append_values",
      description: "Append rows to a spreadsheet.",
      inputSchema: z.object({ q: z.string() }).strict(),
      overrides: {
        title: "Add rows",
        summary: "Append values to a sheet.",
        aliases: ["add rows"],
        tags: ["spreadsheets"],
        entities: ["row"],
        relatedTools: ["contacts.get"],
      },
    });

    assert.equal(discovery.title, "Add rows", "authored title wins over the derived default");
    assert.equal(discovery.summary, "Append values to a sheet.", "authored summary wins");
    assert.ok(
      discovery.aliases?.includes("add rows") && discovery.aliases.includes("sheets append values"),
      "authored and derived aliases are unioned",
    );
    assert.ok(
      discovery.tags?.includes("spreadsheets") && discovery.tags.includes("sheets"),
      "authored tags augment the derived identity tag",
    );
    assert.ok(discovery.verbs?.includes("append"), "the derived verb survives when not overridden");
    assert.deepEqual(
      discovery.relatedTools,
      ["contacts.get"],
      "authored relatedTools pass through",
    );
  });

  test("de-duplicates union members case-insensitively, authored first", () => {
    const discovery = deriveToolDiscovery({
      integration: "github",
      action: "search",
      description: "Search GitHub.",
      inputSchema: z.object({}).strict(),
      // "GitHub" collides with the derived identity tag "github".
      overrides: { tags: ["GitHub", "code"] },
    });

    const githubTags = discovery.tags?.filter((tag) => tag.toLowerCase() === "github") ?? [];
    assert.equal(githubTags.length, 1, "the derived duplicate is dropped");
    assert.equal(githubTags[0], "GitHub", "the authored casing is kept");
  });

  test("degrades to identity-only entities when the schema is not an object", () => {
    const discovery = deriveToolDiscovery({
      integration: "vercel",
      action: "list_projects",
      description: "List projects.",
      inputSchema: z.string(),
    });

    assert.ok(discovery.entities?.includes("project"), "action-derived entities still present");
    assert.ok(Array.isArray(discovery.entities), "no throw on a non-object schema");
  });
});
