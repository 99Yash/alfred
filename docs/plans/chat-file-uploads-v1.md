# Chat file uploads — v1 (ADR-0065)

Adds file upload to chat. Today the composer's paperclip is a **dead button** — no `<input type=file>`, no upload endpoint, no attachment column on `chat_messages`, no file parts in the transcript. The pipeline is text-in/text-out end to end. This plan builds the whole thing.

## The load-bearing invariant (do not violate)

**The boss model only ever receives text and images.** Every non-universally-supported modality (video, audio, PDF, docx/xlsx/code) is **degraded to text (+ optional keyframe images) at ingest**. Images pass through untouched. A user upload produces **two artifacts**:

1. **Raw media** — stored in a Railway bucket, retained for replay/preview in the UI. **Never sent to the model.**
2. **Degraded artifact** — transcript text (+ keyframe image objects) — the *only* thing that enters the transcript and the model context.

This invariant is why there is **no model-capability gate and no force-routing**: nothing unreadable ever reaches the model, so the question "which model can read this attachment" never arises. Tier picker (Auto=Sonnet 4.6 / Deep=Opus 4.8) and attachments are orthogonal. Gemini 2.5 Pro stays a pure reliability fallback, *not* an ingest or routing target. See ADR-0065 for the full rationale and the rejected routing design.

## Why not route unsupported uploads to a capable model (the grilled fork)

Routing is unsound because **file-parts persist in a thread's transcript**: once a video part is in the history, *every subsequent turn replays it*. So a single video would pin the entire thread to Gemini and silently downgrade the user off the tier they chose. Degrading at ingest means the historical transcript only ever holds text+images → no poisoning, no thread-pinning, no tier conflict, and the per-model PDF-capability question (models.dev lists Sonnet 4.6 as image-only) simply disappears. Full alternatives in ADR-0065.

## The degrade pipeline (deterministic — ffmpeg + OpenAI, no Gemini)

Reuses what's already in the tree (`@alfred/ai` `transcribeAudio()` → OpenAI `gpt-4o-mini-transcribe`, `transcription.ts:25`) plus ffmpeg:

| Upload kind | Degrade |
|---|---|
| image (jpeg/png/webp/heic) | **pass-through** → image part |
| audio (mp3/wav/m4a/opus/…) | `transcribeAudio(bytes)` → transcript text |
| video (mp4/webm/mov/…) | ffmpeg split audio track → `transcribeAudio` (transcript) **+** ffmpeg keyframes → image parts |
| pdf | text extraction → text (page-image render **deferred**; scanned/OCR likely `reject` for v1) |
| docx / xlsx / code | text extraction → text (dimension's `mammoth`/xlsx pattern) |
| anything else | **reject** at the boundary with a clear message |

## Storage — files-sdk → Railway buckets, deletion by prefix

- **`files-sdk`** (S3 driver → Railway's S3-compatible buckets) for the bytes. Provider-agnostic `signedUploadUrl()` / `url()` / `delete()`; swap a driver, not app code, if Railway buckets disappoint.
- **Key convention solves deletion** (bucket objects aren't reachable by Postgres FK `CASCADE`): every object lives under **`chat/{userId}/{threadId}/{messageId}/{file}`**. Deletion is a single **prefix delete**, enqueued as a BullMQ cleanup job:
  - **thread delete** → drop `chat/{userId}/{threadId}/`
  - **account delete** → drop `chat/{userId}/` (existing user-FK cascade clears the rows)
- **No reconcile sweeper** for v1 — single-user, near-zero orphan risk; log-and-move-on if a cleanup job fails.
- Raw media **dies with the chat** — it is conversation context, not a media library.
- Per-file caps **10–15 MB** (single-user; dimension's 50 MB are multi-tenant abuse caps, over-built here).

## Orchestration — one turn, graceful partial answer, live status, no proactive messages

The boss harness is strictly request→response today: **cannot await/poll a job mid-turn**, and there are **no proactive follow-up messages** (only `spawn_sub_agent` fire-and-forget + scratchpad-read-on-next-turn, ADR-0036). Proactive follow-up is a **separate epic, out of scope.** Because the user sends prompt + media in one message:

- **Enqueue `media.degrade` the instant a file is attached** (not at send) — degrade runs while the user is still typing, so it's usually done by send-time.
- **Live degrade status** in the composer — **poll a status endpoint ~1s** (worker→web SSE push deferred).
- **Bounded await** at turn time: ready → boss runs with the full degraded artifact; not-ready-in-bound → boss answers the **non-media-dependent** parts of the prompt with an honest "still processing your upload" note; the ready artifact lands naturally on the **next user turn** (no proactive push — prompt and media share a thread).
- **Seam for the future:** attachment + degrade-status pass into the boss context as a **structured field**, so a later epic can add answer-around-pending-media / proactive completion once proactive messages exist (A-now / B-ready-seam, ADR-0060 precedent).

## Scope (in)

- **`@alfred/contracts`** (pure, web-safe, zero Node deps — composer + worker share one truth):
  - `INGEST_POLICY` map: MIME / MIME-class → `{ kind: "pass-through" | "degrade-text" | "degrade-av" | "reject" }`.
  - `SUPPORTED_FILE_TYPES` whitelist + per-type size caps (borrowed from dimension `upload-helpers.ts`).
  - Attachment + degrade-status types (status `pending | ready | failed`).
- **`@alfred/db`**: a `chat_attachments` table (FK → `chat_messages`, **CASCADE**) — storage key, mime, name, size, `status`, `degraded_text`, `degraded_image_keys`, `lifecycle_dates`. `db:generate` → `db:migrate` (**never** `db:push`). A table (not a jsonb column) so async status + per-attachment artifacts update without rewriting the message row.
- **`@alfred/api` storage adapter**: thin `chat-storage` over `files-sdk` (S3 driver, Railway creds via `serverEnv()`) — `signedUploadUrl`, `url`, `deletePrefix`, key builder enforcing the convention.
- **`@alfred/api` upload endpoint**: mint signed PUT URL for `chat/{userId}/{threadId}/{messageId}/…`, create the `chat_attachments` row (`pending`), enqueue `media.degrade`.
- **`@alfred/api` degrade worker** (`ingestion-runs` queue, new job `media.degrade { attachmentId, userId }`): run the table above, write the degraded artifact, flip status. Reuses `transcribeAudio`; ffmpeg for video.
- **`@alfred/api` chat-turn**: transcript assembly maps **ready** attachments → AI-SDK text + image parts; raw media never sent; bounded-await + status-into-context seam.
- **`apps/web` composer**: wire the dead paperclip (`-chat/chat-shell.tsx:1031`); borrow dimension's `attachment-input` UX (multi-file, drag/drop/paste, client-side validation against shared whitelist + caps, trivial doc→text client-side); signed-URL upload; live degrade-status render.
- **Deploy**: add **ffmpeg** to the `apps/server` image (Nixpacks/Dockerfile) — workers run in-process in `server`.
- **Thread/account delete**: enqueue the prefix-delete cleanup job.

## Scope (out / parked)

- **Proactive completion messages** ("I've finished reading your video") — the centrality epic; needs proactive messaging (SSE/notifications/request-response contract change).
- **SSE-pushed degrade status** — poll-1s for v1.
- **PDF page-image rendering** — text-only v1; scanned-PDF OCR likely `reject` until v2.
- **Scene-detection keyframes / frame-count tuning** — fixed-interval v1.
- **Bucket↔DB reconcile sweeper** — single-user, log-only v1.
- **Media library / sharing beyond thread lifetime** — raw media dies with the chat.
- **Embedding/RAG over uploaded files** — these are turn-scoped context, not an ingested corpus (unlike Gmail/Drive).
- **`MODEL_CAPABILITIES` registry + force-routing** — rejected by ADR-0065; the invariant removes the need.

## Build order

0. **ADR-0065 written** (decisions.md) — degrade-at-ingest invariant, storage/lifecycle, orchestration, rejected routing design. ✅
1. **Bytes path (images only, no degrade).** ✅ **Built 2026-06-22.** `chat_attachments` table (migrations 0045+0046, `rowVersion` for sync) + `chat/storage.ts` (files-sdk → Railway buckets) + `POST /attachments/sign` + composer wiring (paperclip → file input, validation, drag/drop/paste, chips) + image-part transcript assembly + thread-delete prefix cleanup (`media.cleanup` job). **Render via Replicache sync** (chat_attachments is a synced entity) + auth-gated content proxy `GET /attachments/:id/content`. Upload-at-send. All 13 packages typecheck. **Not yet runtime-tested — needs a Railway bucket + `CHAT_S3_*` env vars.**
2. **Degrade worker — no-ffmpeg modalities.** `media.degrade` job: audio (`transcribeAudio`), pdf/docx/xlsx/code → text. Status transitions + live poll UI + bounded-await + graceful partial-answer + status-into-context seam.
3. **Video.** ffmpeg in the server image → audio-split transcript + keyframe image parts.
4. **Hardening.** Cap/timeout/keyframe tuning from real usage; eval/error cases; confirm poll-vs-SSE.

## Open questions

- Exact per-type caps within 10–15 MB; total files per message.
- Bounded-await timeout (does the enqueue-on-attach head-start make it rarely fire?).
- Keyframe interval + max count.
- PDF text-extraction lib; scanned-PDF OCR posture.
- docx/xlsx→text client-side (`mammoth`) vs in the worker.
- Status transport: confirm 1s-poll acceptable vs a small SSE addition.

## Key references

- ADR-0065 (decisions.md) — the decision + full alternatives.
- `@alfred/ai` `transcription.ts:25` — `transcribeAudio()`, reused as-is.
- `ingestion-runs` queue / worker (`modules/integrations/queue.ts`) — the BullMQ pattern a `media.degrade` job slots into; workers in-process in `apps/server`.
- chat-turn workflow (`modules/agent/workflows/chat-turn.ts`) — transcript assembly + the boss-context seam.
- Composer paperclip — `apps/web/src/routes/-chat/chat-shell.tsx:1031`.
- Dimension reference (borrow UX/validation only): `apps/web/.../chat-input/_components/attachment-input.tsx`, `utils/upload-helpers.ts`.
- `files-sdk` — https://github.com/haydenbleasel/files-sdk (S3 driver → Railway buckets).
