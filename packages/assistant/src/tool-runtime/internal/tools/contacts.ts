/** Google Contacts tools (People API). Read-only: the grant is `contacts.readonly` + `contacts.other.readonly`. */

import {
  CONTACT_SOURCES,
  contactsGetInput,
  contactsListInput,
  contactsSearchInput,
  type ContactSource,
} from "@alfred/contracts";
import {
  AppError,
  publicAppError,
  toPublicAppError,
  type PublicAppError,
} from "@alfred/contracts/app-errors";
import type { ContactSummary } from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";

export const contactsTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "contacts",
    action: "search",
    riskTier: "no_risk",
    description:
      "Find a person in the user's Google Contacts by name, email, or phone (saved contacts also match on organization). Searches saved contacts and 'Other contacts' (people the user emailed but never saved); each result names its `source`. Use it to resolve a name to an email address before you write to someone.",
    discovery: {
      aliases: ["find contact", "look up contact", "address book", "email address for"],
      tags: ["contacts", "people", "address book"],
      entities: ["contact", "person", "email address", "phone number"],
      verbs: ["search", "find", "look up"],
      relatedTools: ["contacts.get", "gmail.search"],
    },
    inputSchema: contactsSearchInput,
    execute: async (input, ctx) => {
      const credentialId = (await ctx.integrations.google.contacts.credential()).id;
      const sources = input.source === "all" ? CONTACT_SOURCES : [input.source];

      const contacts: ContactSummary[] = [];
      const failures: Array<{ source: ContactSource } & PublicAppError> = [];

      // One source can fail alone (a scope unchecked at consent); keep the other's results.
      await Promise.all(
        sources.map(async (source) => {
          try {
            contacts.push(
              ...(await ctx.integrations.google.contacts.searchContacts({
                credentialId,
                query: input.query,
                source,
                pageSize: input.maxResults,
              })),
            );
          } catch (err) {
            const failure = toPublicAppError(
              err,
              publicAppError("account_read_failed", { integration: "contacts" }),
            );

            logger.error(
              { err, event: "contacts_source_read_failed", source, userId: ctx.userId },
              failure.message,
            );
            failures.push({ source, ...failure });
          }
        }),
      );

      if (failures.length === sources.length) {
        throw new AppError("integration_unavailable", { integration: "contacts" });
      }

      return { contacts, ...(failures.length > 0 ? { failures } : {}) };
    },
  }),
  liveTool({
    integration: "contacts",
    action: "list",
    riskTier: "no_risk",
    description:
      "Page through the user's saved Google Contacts (newest edits first) or their 'Other contacts'. Prefer contacts.search to find one person.",
    inputSchema: contactsListInput,
    execute: async (input, ctx) => {
      const credentialId = (await ctx.integrations.google.contacts.credential()).id;

      return ctx.integrations.google.contacts.listContacts({
        credentialId,
        source: input.source,
        pageSize: input.pageSize,
        pageToken: input.pageToken,
      });
    },
  }),
  liveTool({
    integration: "contacts",
    action: "get",
    riskTier: "low",
    description:
      "Read one saved contact in full: nicknames, all emails and phones, organization, addresses, birthday, notes, links, relations, and dates. Takes a `people/…` resourceName from contacts.search or contacts.list.",
    inputSchema: contactsGetInput,
    execute: async (input, ctx) => {
      const credentialId = (await ctx.integrations.google.contacts.credential()).id;

      return ctx.integrations.google.contacts.getContact({
        credentialId,
        resourceName: input.resourceName,
      });
    },
  }),
];
