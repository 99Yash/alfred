import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_SNIPPET_MAX_CHARS,
  sourceRefFromManifest,
  type ContextSearchRequest,
  type EvidenceAuthority,
  type EvidenceCard,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import {
  chatTurnExcerpt,
  recallChatExchanges,
  type ChatExchangeHit,
} from "@alfred/assistant/knowledge";
import { defineContextSource, type ContextSource } from "./registry";
import { renderContent } from "./vector-source";

/**
 * Past chats (journal.md section 3): the user's earlier exchanges with Alfred, in every thread.
 * One hit gives two cards with different authority (principle 5): the user's message is the
 * user's own words, and the reply is Alfred's own output, which is never evidence. The reply card
 * names the model that wrote it.
 */
const CHAT_CONTEXT_SOURCE_ID = "chat";

const CHAT_CONTEXT_SOURCE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "internal",
  displayName: "Past chats",
  freshness: { typical: "ingested" },
  authority: {
    level: "medium",
    label: "the user's own words, and Alfred's earlier replies, which are not evidence",
  },
  cost: { class: "metered" },
  availability: "available",
  mediaKinds: ["text"],
};

const USER_TURN_AUTHORITY: EvidenceAuthority = {
  level: "high",
  label: "the user's own words in an earlier chat",
};

function chatManifest(): SourceManifest {
  return { ...CHAT_CONTEXT_SOURCE_MANIFEST_BASE, id: CHAT_CONTEXT_SOURCE_ID };
}

export function createChatContextSource(): ContextSource {
  return defineContextSource({
    id: CHAT_CONTEXT_SOURCE_ID,
    manifest: CHAT_CONTEXT_SOURCE_MANIFEST_BASE,
    reads: { semantic_search: readPastChats },
  });
}

async function readPastChats(request: ContextSearchRequest, signal: AbortSignal) {
  const hits = await recallChatExchanges({
    userId: request.userId,
    query: request.query,
    limit: request.limit,
    abortSignal: signal,
  });

  return { evidence: hits.flatMap(chatHitToEvidenceCards) };
}

function replyAuthority(models: readonly string[]): EvidenceAuthority {
  const writer = models.length > 0 ? `written by ${models.join(", ")}` : "model not recorded";

  return {
    level: "low",
    label: `Alfred's own earlier reply (${writer}), not evidence`.slice(0, 200),
  };
}

/** The user's message, then the reply when it has text. Both cite the thread and message ids. */
function chatHitToEvidenceCards(hit: ChatExchangeHit): EvidenceCard[] {
  const source = sourceRefFromManifest(chatManifest());
  const title = hit.threadTitle ?? "Untitled chat";
  const label = `Chat "${title}"`.slice(0, EVIDENCE_CITATION_LABEL_MAX_CHARS);

  const userCard: EvidenceCard = {
    id: `${CHAT_CONTEXT_SOURCE_ID}:${hit.user.id}`,
    source,
    mediaKind: "text",
    ...renderContent(
      chatTurnExcerpt(hit.user.content, EVIDENCE_SNIPPET_MAX_CHARS),
      "This message has no stored text.",
    ),
    score: hit.similarity,
    authority: USER_TURN_AUTHORITY,
    time: { occurredAt: hit.user.createdAt.toISOString(), freshness: "ingested" },
    citations: [{ label, locator: `chat thread ${hit.threadId}, user message ${hit.user.id}` }],
  };

  const replyText = chatTurnExcerpt(hit.reply.content, EVIDENCE_SNIPPET_MAX_CHARS);

  if (replyText.length === 0) return [userCard];

  const replyCard: EvidenceCard = {
    id: `${CHAT_CONTEXT_SOURCE_ID}:${hit.reply.id}`,
    source,
    mediaKind: "text",
    snippet: replyText,
    score: hit.similarity,
    authority: replyAuthority(hit.reply.models),
    time: { occurredAt: hit.reply.createdAt.toISOString(), freshness: "ingested" },
    citations: [
      {
        label,
        locator: `chat thread ${hit.threadId}, reply ${hit.reply.id} to user message ${hit.user.id}`,
      },
    ],
  };

  return [userCard, replyCard];
}
