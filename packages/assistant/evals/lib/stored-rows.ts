import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@alfred/db";
import {
  documents,
  emailTriage,
  integrationCredentials,
  integrationObjectKeys,
  integrationObjects,
  mcpConnections,
  mcpServers,
  user,
} from "@alfred/db/schemas";
import { RAILWAY_MCP_ENDPOINT_HREF } from "@alfred/assistant/connections/mcp";
import { evalStoredGmailMessage, type EvalStoredMail } from "./stored-mail";

/**
 * Seeders for the eval suites that replay redacted stored rows through the real store readers
 * (the `triage-deck` practice, at the database): one throwaway `user` row per case, everything
 * else cascading from it. The ids are deterministic per case, so a crashed run's rows are
 * deleted before the case seeds again. The rows are synthetic — `example.test` addresses, no
 * real names or bodies — because redaction is the privacy gate (ADR-0133), and a fixture that
 * carries a real body is a boundary fault.
 */

/** Every seeded row hangs off a user id with this prefix. */
const EVAL_USER_PREFIX = "eval-stored-rows-";

/**
 * One throwaway owner for a case. Deletes the case's stale user first, so a crashed run
 * cannot double its rows. Delete the row (not the rows it cascades to) when the case ends.
 */
export async function seedEvalUser(caseId: string): Promise<string> {
  const userId = `${EVAL_USER_PREFIX}${caseId}`;

  await db().delete(user).where(eq(user.id, userId));
  await db()
    .insert(user)
    .values({ id: userId, name: "Stored Rows Eval", email: `${userId}@example.test` });

  return userId;
}

/** Delete one case's user; every seeded row cascades. */
export async function deleteEvalUser(userId: string): Promise<void> {
  await db().delete(user).where(eq(user.id, userId));
}

/**
 * One triaged Gmail thread as the stores hold it: a `documents` row whose `raw` is a stored
 * Gmail message and an `email_triage` row pointing at it. `storedMail: false` seeds the triage
 * row without its mail — `email_triage.document_id` has no FK, by design, so a purged message
 * leaves the row — which is the reader's `unreadMail` sight.
 */
export async function seedTriageThread(
  userId: string,
  mail: Pick<EvalStoredMail, "from" | "subject" | "body" | "authoredAt"> & {
    /** `false` stores the triage row alone: the thread whose mail never arrived. */
    readonly storedMail?: boolean;
  },
): Promise<string> {
  const sourceId = `eval_${randomUUID()}`;

  let documentId: string;

  if (mail.storedMail === false) {
    documentId = `doc_unstored_${sourceId}`;
  } else {
    const [document] = await db()
      .insert(documents)
      .values({
        userId,
        source: "gmail",
        sourceId,
        sourceThreadId: sourceId,
        title: mail.subject,
        content: mail.body,
        contentHash: `${sourceId}_hash`,
        raw: evalStoredGmailMessage({
          id: sourceId,
          from: mail.from,
          subject: mail.subject,
          body: mail.body,
          authoredAt: mail.authoredAt,
          labelIds: ["INBOX"],
        }),
        authoredAt: mail.authoredAt,
        metadata: { from: mail.from, snippet: mail.body.slice(0, 160), labelIds: ["INBOX"] },
      })
      .returning({ id: documents.id });

    if (!document) throw new Error("[stored-rows] the document row returned no id");

    documentId = document.id;
  }

  await db().insert(emailTriage).values({
    userId,
    sourceThreadId: sourceId,
    category: "fyi",
    confidence: 0.9,
    model: "eval-stored-rows",
    documentId,
    classifiedAt: mail.authoredAt,
  });

  return documentId;
}

/** A connected GitHub App credential: durable connection truth for a live provider. */
export async function seedGithubCredential(userId: string): Promise<void> {
  await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "github",
      accountId: `eval_${randomUUID()}`,
      accountLabel: "yash@example.test",
      // Unsealed on purpose: the footprint reader never opens the token.
      accessToken: sql`'eval-token'`,
      installationId: `inst_${randomUUID()}`,
      scopes: [],
      status: "active",
    });
}

/** A ready MCP connection to Railway's built-in endpoint: connection truth for a planned provider. */
export async function seedRailwayMcpConnection(userId: string): Promise<void> {
  const endpoint = new URL(RAILWAY_MCP_ENDPOINT_HREF);

  const [server] = await db()
    .insert(mcpServers)
    .values({
      userId,
      canonicalResource: RAILWAY_MCP_ENDPOINT_HREF,
      endpointUrl: RAILWAY_MCP_ENDPOINT_HREF,
      endpointOrigin: endpoint.origin,
    })
    .returning({ id: mcpServers.id });

  if (!server) throw new Error("[stored-rows] the mcp server row returned no id");

  await db().insert(mcpConnections).values({
    userId,
    serverId: server.id,
    instanceKey: "default",
    label: "Railway",
    status: "ready",
  });
}

/**
 * One owned object, optionally with a typed key. `provider` is the row's own typed provider
 * value, which the admission rule may match by itself or pass over for the identity value.
 */
export async function seedObjectRow(
  userId: string,
  args: {
    readonly provider: string;
    readonly kind: string;
    readonly externalId: string;
    readonly url: string | null;
    readonly title?: string | null;
    readonly keys?: readonly { readonly keyKind: string; readonly keyValue: string }[];
  },
): Promise<void> {
  const [object] = await db()
    .insert(integrationObjects)
    .values({
      userId,
      provider: args.provider,
      kind: args.kind,
      externalId: args.externalId,
      stateCategory: "active",
      title: args.title ?? null,
      url: args.url,
    })
    .returning({ id: integrationObjects.id });

  if (!object) throw new Error("[stored-rows] the object row returned no id");

  for (const key of args.keys ?? []) {
    await db().insert(integrationObjectKeys).values({
      userId,
      objectId: object.id,
      provider: args.provider,
      keyKind: key.keyKind,
      keyValue: key.keyValue,
    });
  }
}
