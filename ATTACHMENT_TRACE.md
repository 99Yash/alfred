# File Upload & Attachment Handling in Alfred Chat — Trace Report

## Summary
The Alfred chat application currently has **NO file upload or attachment handling implemented**. The "Attach file" UI button exists as a placeholder but is non-functional and has no backend infrastructure to support it.

---

## 1. Frontend Upload Path

### Composer UI
**File:** `/Users/yash/Developer/self/alfred/apps/web/src/routes/-chat/chat-shell.tsx:1031-1035`

```tsx
<Tip label="Attach file">
  <ComposerIcon label="Attach file" disabled={disabled || mic.recording}>
    <Paperclip size={14} />
  </ComposerIcon>
</Tip>
```

**Status:** Button is rendered but has **NO onClick handler**. The `ComposerIcon` component accepts optional `onClick` prop (line 1231), but the attach button call passes no `onClick`, so clicking it does nothing.

**Accepted file types:** NONE specified (no `accept=` attribute exists in any file input).

**File storage/sending:** No mechanism. There is:
- No `<input type="file">` element
- No FileReader or file picker implementation
- No FormData or multipart upload logic
- No handler to convert files to message parts

### Draft Persistence
Drafts are persisted to localStorage using Tiptap's `JSONContent` format (line 753-768 in chat-shell.tsx), but this is **text-only**—no provision for attachments.

---

## 2. Message/Attachment Data Model

### Message Schema (Database)
**File:** `/Users/yash/Developer/self/alfred/packages/db/src/schema/chat.ts:72-116`

```typescript
export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  threadId: text("thread_id").notNull(),
  role: text("role").notNull().$type<ChatMessageRole>(),  // 'user' | 'assistant'
  content: text("content").notNull().default(""),         // Plain text only
  reasoning: text("reasoning"),
  reasoningMs: integer("reasoning_ms"),
  status: text("status").notNull().$type<ChatMessageStatus>(),
  toolCalls: jsonb("tool_calls").$type<ChatMessageToolCall[]>(),
  narration: jsonb("narration").$type<ChatMessageNarration[]>(),
  runId: text("run_id"),
  rowVersion: integer("row_version").notNull().default(0),
  // ... lifecycle dates
});
```

**No attachment columns.** The `chatMessages` table has NO fields for files, attachments, media types, MIME types, or parts.

### Transcript Contract
**File:** `/Users/yash/Developer/self/alfred/packages/contracts/src/transcript.ts:1-7`

```typescript
export interface AgentTranscriptMessage {
  role: AgentTranscriptRole;           // 'system' | 'user' | 'assistant' | 'tool'
  content: unknown;                     // Polymorphic, but no file-part handling defined
  providerOptions?: Record<string, unknown>;
}
```

**Status:** `content` is just `unknown`—no schema enforces or documents file-part support. The Vercel AI SDK's `ModelMessage` type (imported in `agent.ts`) can include parts like `ImagePart` and `FilePart`, but the Alfred contracts don't codify that or enforce validation.

### Message Creation (API)
**File:** `/Users/yash/Developer/self/alfred/packages/api/src/modules/chat/index.ts:130-141`

```typescript
await db()
  .insert(chatMessages)
  .values({
    id: body.userMessageId,
    userId: user.id,
    threadId,
    role: "user",
    content,                  // Plain text string only
    status: "complete",
  })
  .onConflictDoNothing();
```

The endpoint `/api/chat/threads/:threadId/turn` accepts a JSON body with `{ userMessageId, content, tier }` (line 195-200). No file/attachment fields exist in the schema.

---

## 3. Server/Boss Handling

### Chat Turn Endpoint
**File:** `/Users/yash/Developer/self/alfred/packages/api/src/modules/chat/index.ts:104-202`

The endpoint receives:
```typescript
{
  userMessageId: string,
  content: string,
  tier?: 'standard' | 'deep'
}
```

**No file upload mechanism.** The endpoint does not:
- Accept multipart form data
- Handle file uploads
- Transform files into message parts
- Validate media types

### Boss Agent (Chat Turn Workflow)
**File:** `/Users/yash/Developer/self/alfred/packages/ai/src/provider.ts:113-117`

```typescript
export function getChatModel(tier: ChatModelTier = "standard"): LanguageModel {
  return tier === "deep"
    ? withFallback(anthropicModel("claude-opus-4-8"), googleModel("gemini-3.5-flash"))
    : withFallback(anthropicModel("claude-sonnet-4-6"), googleModel("gemini-3.5-flash"));
}
```

**Model:** Primary is Anthropic (Claude Sonnet 4.6 for standard, Opus 4.8 for deep). Both models support image/PDF/video inputs via their SDKs, but Alfred doesn't construct or pass file parts to them.

### Transcript Loading
**File:** `/Users/yash/Developer/self/alfred/packages/api/src/modules/agent/workflows/chat-turn.ts:1021-1032`

```typescript
async initialTranscript(input) {
  const rows = await db()
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, input.userId), eq(chatMessages.threadId, threadId)))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  return rows
    .filter((r) => r.content.length > 0)
    .map((r) => ({ role: r.role, content: r.content }) satisfies AgentTranscriptMessage);
}
```

The transcript is built from the database rows—just plain-text `content` fields. No file parts are extracted or constructed.

### Model Invocation
**File:** `/Users/yash/Developer/self/alfred/packages/ai/src/agent.ts:185-190`

```typescript
const result = await meteredGenerateText(
  {
    model,
    system: buildSystem(system, this.cacheTtl()),
    messages: transcript,      // Passed as-is from DB (text only)
    tools,
    stopWhen: stepCountIs(1),
    maxOutputTokens: this.s.maxOutputTokens,
    temperature: this.s.temperature,
    providerOptions: this.s.providerOptions as Record<string, never> | undefined,
```

**No validation on message parts.** The transcript is passed directly to the model without any branching, filtering, or error handling based on media type.

---

## 4. Unsupported Type Handling

### Validation
**None.** There is:
- No file-type whitelist (image, video, PDF, etc.)
- No file-size validation
- No MIME-type checking
- No guard that rejects unsupported media types before the model call

### Fallback/Rejection
**None.** The system doesn't:
- Reject files if they're not supported by the active model
- Provide error messages for incompatible file types
- Route unsupported types elsewhere
- Warn the user before sending to the model

### Model-specific handling
**None.** There is no:
- Branch for Gemini vs Anthropic's different media-type support
- Fallback when the primary Anthropic model lacks support for a type
- Graceful degradation when media types are passed to models that don't support them

---

## What's Currently Stored (User Messages Only)

When a user submits a chat turn:

1. **Frontend** (`use-send-message.ts:67-73`): Calls Replicache mutator with `{ id, threadId, userId, content, createdAt }`—text only.
2. **Backend** (`chat/index.ts:131-141`): Upserts `chatMessages` row with `{ id, userId, threadId, role: "user", content, status: "complete" }`.
3. **Transcript** (`chat-turn.ts:1025-1032`): Loads all `chatMessages` rows, extracts `role` and `content` fields, converts to `AgentTranscriptMessage[]`.
4. **Model** (`agent.ts:189`): Passes transcript to LLM as `ModelMessage[]`.

**No attachment data flows through any part of this pipeline.**

---

## Gap Analysis

| Aspect | Status | Evidence |
|--------|--------|----------|
| Frontend file picker | ❌ Not implemented | No `<input type="file">`, no click handler on attach button |
| File upload endpoint | ❌ Not implemented | `/api/chat/threads/:id/turn` accepts only `{ userMessageId, content, tier }` |
| Database attachment storage | ❌ Not implemented | `chatMessages` table has no attachment/file columns |
| Message-part schema | ❌ Not defined | `AgentTranscriptMessage.content: unknown` (no file-part enforcement) |
| File validation | ❌ Not implemented | No MIME-type, file-size, or type whitelist checks |
| Model dispatch branching | ❌ Not implemented | No model-specific media-type routing or fallback |
| Error handling | ❌ Not implemented | No rejection or graceful degradation for unsupported types |

---

## Architecture Implications

To implement file uploads, you would need to:

1. **Frontend:** Add file picker + drag-drop, serialize to FormData, post to new `/api/chat/upload` endpoint.
2. **Backend:** Create upload endpoint, store files (S3/blob storage), generate file IDs.
3. **Database:** Extend `chatMessages` to include `attachments: jsonb` field (or separate `chat_attachments` table).
4. **Contract:** Define `FilePart | ImagePart | ...` in `AgentTranscriptMessage.content` union.
5. **Boss Logic:** Extend `initialTranscript()` to load attachment metadata, construct `FilePart` objects for each file, pass to LLM.
6. **Validation:** Add model-aware branching—Anthropic supports images/video/PDFs; Gemini has different constraints.
7. **Error Handling:** Guard against unsupported types before model invocation, provide user-facing error messages.

The current state is a UI placeholder with zero backend infrastructure.
