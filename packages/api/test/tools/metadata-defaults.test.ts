import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { z } from "zod";

import { deriveToolDiscovery } from "../../src/modules/tools/metadata-defaults";

describe("deriveToolDiscovery", () => {
  test("derives a searchable baseline from identity, action, and schema fields", () => {
    const discovery = deriveToolDiscovery({
      integration: "notion",
      action: "create_page",
      description: "Create a Notion page under a parent.",
      inputSchema: z
        .object({
          title: z.string(),
          parentId: z.string(),
          content: z.string(),
          pageToken: z.string().optional(),
        })
        .strict(),
    });

    assert.equal(discovery.title, "Create Page", "title defaults to the humanized action");
    assert.equal(
      discovery.summary,
      "Create a Notion page under a parent.",
      "summary defaults to the description",
    );
    assert.ok(discovery.tags?.includes("notion"), "the server identity becomes a tag");
    assert.ok(discovery.verbs?.includes("create"), "the leading action token is a verb");
    assert.ok(discovery.verbs?.includes("add"), "generic verb synonyms improve recall");
    assert.ok(discovery.entities?.includes("page"), "trailing action tokens are entities");
    assert.ok(
      discovery.entities?.includes("title") && discovery.entities?.includes("content"),
      "meaningful schema field names become entities",
    );
    assert.ok(discovery.entities?.includes("parent"), "camelCase fields split into noun tokens");
    assert.ok(
      !discovery.entities?.includes("id") && !discovery.entities?.includes("pagetoken"),
      "plumbing field tokens are excluded",
    );
    assert.ok(
      discovery.aliases?.includes("create page") &&
        discovery.aliases?.includes("notion create page"),
      "aliases map likely phrasings onto the capability",
    );
    assert.equal(discovery.relatedTools, undefined, "relatedTools is authored-only");
  });

  test("singularizes entities so a query matches either number", () => {
    const discovery = deriveToolDiscovery({
      integration: "railway",
      action: "list_deployments",
      description: "List deployments.",
      inputSchema: z.object({}).strict(),
    });
    assert.ok(discovery.entities?.includes("deployment"), "plural action noun is singularized");
    assert.ok(discovery.entities?.includes("deployments"), "the original plural is kept too");
  });

  test("merges hand-authored overrides on top of the derived baseline", () => {
    const discovery = deriveToolDiscovery({
      integration: "gmail",
      action: "search",
      description: "Search Gmail messages.",
      inputSchema: z.object({ q: z.string() }).strict(),
      overrides: {
        title: "Search email",
        summary: "Find messages in the inbox.",
        aliases: ["find email"],
        tags: ["communication"],
        entities: ["message"],
        relatedTools: ["gmail.read_message"],
      },
    });

    assert.equal(discovery.title, "Search email", "authored title wins over the derived default");
    assert.equal(discovery.summary, "Find messages in the inbox.", "authored summary wins");
    assert.ok(
      discovery.aliases?.includes("find email") && discovery.aliases?.includes("gmail search"),
      "authored and derived aliases are unioned",
    );
    assert.ok(
      discovery.tags?.includes("communication") && discovery.tags?.includes("gmail"),
      "authored tags augment the derived identity tag",
    );
    assert.ok(discovery.verbs?.includes("search"), "the derived verb survives when not overridden");
    assert.deepEqual(
      discovery.relatedTools,
      ["gmail.read_message"],
      "authored relatedTools pass through",
    );
  });

  test("de-duplicates union members case-insensitively, authored first", () => {
    const discovery = deriveToolDiscovery({
      integration: "notion",
      action: "search",
      description: "Search Notion.",
      inputSchema: z.object({}).strict(),
      // "Notion" collides with the derived identity tag "notion".
      overrides: { tags: ["Notion", "workspace"] },
    });
    const notionTags = discovery.tags?.filter((tag) => tag.toLowerCase() === "notion") ?? [];
    assert.equal(notionTags.length, 1, "the derived duplicate is dropped");
    assert.equal(notionTags[0], "Notion", "the authored casing is kept");
  });

  test("degrades to identity-only entities when the schema is not an object", () => {
    const discovery = deriveToolDiscovery({
      integration: "docs",
      action: "get_document",
      description: "Read a document.",
      inputSchema: z.string(),
    });
    assert.ok(discovery.entities?.includes("document"), "action-derived entities still present");
    assert.ok(Array.isArray(discovery.entities), "no throw on a non-object schema");
  });
});
