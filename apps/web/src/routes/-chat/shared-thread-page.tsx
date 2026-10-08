import type { SharedThreadArtifact, SharedThreadMessage } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, FileText, Layers, Loader2, Lock, Paperclip, RotateCcw } from "lucide-react";
import { useState } from "react";
import { AppThemed, AppThemeProvider } from "~/components/ui/v2";
import { FrostButton } from "~/components/landing/frost-button";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { MessageBubble } from "./message-bubble";
import { PublishedTranscript, useMarkdownImageMode } from "./published-transcript";
import { SharingRequestError, useSharedThreadPage } from "~/lib/sharing/use-thread-sharing";
import { cn } from "~/lib/utils";

/**
 * Public read-only `/c/$slug` (ADR-0102). Signed out; its only data is the `GET /api/shared/:slug` snapshot.
 * Do not add Replicache, a session, or a synced hook. The route's `publicRoute: true` stops the `/login` redirect.
 * `MessageBubble` must make no authenticated read; nothing in the build catches one.
 */

/** `FrostButton` has no `asChild`, and a button inside a link is invalid, so it navigates on click. */
function TryAlfredButton({ size = "md", children }: { size?: "sm" | "md"; children: string }) {
  const navigate = useNavigate();

  return (
    <FrostButton size={size} className="shrink-0" onClick={() => void navigate({ to: "/" })}>
      {children}
      <ArrowRight size={14} aria-hidden />
    </FrostButton>
  );
}

/**
 * Signed-out invitation, docked where the composer would be.
 * The copy does not promise "start chatting": Alfred has no fork path (ADR-0102).
 * It links to `/`, not sign-in, because this page holds no session.
 */
function TryAlfredBanner() {
  return (
    <div className="sticky bottom-0 z-10 -mx-5 mt-8 px-5 pb-4">
      {/* Fades the transcript out under the pill. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-full h-16 bg-linear-to-b from-transparent to-app-background"
      />
      <div
        className={cn(
          "frost-border flex flex-wrap items-center gap-x-4 gap-y-3",
          "rounded-[28px] bg-app-bg-2/60 px-4 py-3.5 backdrop-blur-md",
        )}
      >
        <img
          src="/images/logo/alfred-logo.svg"
          alt=""
          className="size-10 shrink-0 rounded-[12px]"
        />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium text-app-fg-4">This is Alfred.</p>
          <p className="text-[13px] leading-snug text-app-fg-2">The Co-worker that never sleeps.</p>
        </div>
        <div className="ml-auto">
          <TryAlfredButton>Try Alfred</TryAlfredButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Fill the fields the snapshot omits with "render nothing" values.
 * Keep `threadId` a placeholder: `Conversation` would open Replicache with a real one.
 */
function toRenderableMessage(message: SharedThreadMessage): SyncedChatMessage {
  return {
    id: message.id,
    userId: "",
    threadId: "",
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    reasoningMs: message.reasoningMs,
    status: message.status,
    errorKind: null,
    toolCalls: message.toolCalls,
    narration: message.narration,
    usage: null,
    runId: null,
    rowVersion: 0,
    createdAt: message.createdAt,
    updatedAt: null,
  };
}

/**
 * One published artifact. The wire schema has only two body variants, so this branch is exhaustive.
 * A `pages` artifact publishes only its count (ADR-0102 D7); its HTML repeats tool results.
 */
function ArtifactPanel({ artifact }: { artifact: SharedThreadArtifact }) {
  const { body } = artifact;
  const images = useMarkdownImageMode();

  return (
    <section className="rounded-2xl border border-app-bg-3/70 bg-app-bg-1 p-5">
      <div className="mb-3 flex items-center gap-2">
        {body.kind === "pages" ? (
          <Layers size={14} aria-hidden className="text-app-fg-2" />
        ) : (
          <FileText size={14} aria-hidden className="text-app-fg-2" />
        )}
        <h2 className="truncate text-sm font-medium text-app-fg-4">{artifact.title}</h2>
      </div>
      {body.kind === "document" ? (
        <MarkdownRenderer size="compact" tone="surface" images={images}>
          {body.markdown}
        </MarkdownRenderer>
      ) : (
        <p className="text-xs text-app-fg-2">
          {body.pageCount} {body.pageCount === 1 ? "page" : "pages"} — open this thread in Alfred to
          view them.
        </p>
      )}
    </section>
  );
}

/** Attachment counts only: the bytes sit behind the owner's auth-gated proxy. */
function AttachmentNote({ count, role }: { count: number; role: "user" | "assistant" }) {
  return (
    <p
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg bg-app-bg-2 px-2.5 py-1 text-xs text-app-fg-2",
        role === "user" ? "self-end" : "self-start",
      )}
    >
      <Paperclip size={12} aria-hidden />
      {count} {count === 1 ? "file" : "files"} — not published
    </p>
  );
}

/** Shared frame for every non-populated state. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">{children}</div>
    </div>
  );
}

/**
 * 404 covers both revoked and never-existed links, with one message so a guess is not confirmed.
 * Other statuses are server or network failures and get a retry.
 */
function SharedThreadUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const gone = error instanceof SharingRequestError && error.status === 404;

  return (
    <Centered>
      {gone ? (
        <Lock size={18} aria-hidden className="text-app-fg-2" />
      ) : (
        <RotateCcw size={18} aria-hidden className="text-app-fg-2" />
      )}
      <h1 className="text-base font-medium text-app-fg-4">
        {gone ? "This link is not available" : "This thread did not load"}
      </h1>
      <p className="text-sm text-app-fg-2">
        {gone
          ? "The thread was never shared, or its link has been revoked."
          : "Something went wrong on our side. The link itself may still be good."}
      </p>
      {gone ? (
        <TryAlfredButton>Go to Alfred</TryAlfredButton>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <FrostButton size="sm" onClick={onRetry}>
            Try again
          </FrostButton>
          <TryAlfredButton size="sm">Go to Alfred</TryAlfredButton>
        </div>
      )}
    </Centered>
  );
}

function SharedThreadBody({ urlSlug }: { urlSlug: string }) {
  const query = useSharedThreadPage(urlSlug);
  const [showArtifacts, setShowArtifacts] = useState(false);

  if (query.isPending) {
    return (
      <Centered>
        <Loader2 size={18} aria-hidden className="animate-spin text-app-fg-2" />
        <p className="text-sm text-app-fg-2">Loading shared thread&hellip;</p>
      </Centered>
    );
  }

  if (query.isError || !query.data) {
    return <SharedThreadUnavailable error={query.error} onRetry={() => void query.refetch()} />;
  }

  const { title, messages, artifacts, sharedAt } = query.data;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-5">
      <header className="sticky top-0 z-10 -mx-5 mb-2 bg-app-background/80 px-5 py-4 backdrop-blur-md">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium text-app-fg-4">{title}</h1>
            <p className="mt-0.5 text-xs text-app-fg-2">
              Shared from Alfred on{" "}
              {new Date(sharedAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-8 py-4">
        {messages.map((message) => (
          // Above the bubble, as the owner's chat draws attachments on a user turn.
          <div key={message.id} className="flex flex-col gap-2">
            {message.attachmentCount > 0 ? (
              <AttachmentNote count={message.attachmentCount} role={message.role} />
            ) : null}
            <MessageBubble message={toRenderableMessage(message)} />
          </div>
        ))}
      </div>

      {artifacts.length > 0 ? (
        <div className="mt-8 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowArtifacts((open) => !open)}
            className={cn(
              "self-start rounded-lg px-2 py-1 text-xs font-medium",
              "text-app-fg-3 transition-colors hover:bg-app-bg-a2 hover:text-app-fg-4",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            )}
          >
            {showArtifacts ? "Hide" : "Show"} {artifacts.length}{" "}
            {artifacts.length === 1 ? "artifact" : "artifacts"}
          </button>
          {showArtifacts
            ? artifacts.map((artifact) => <ArtifactPanel key={artifact.id} artifact={artifact} />)
            : null}
        </div>
      ) : null}

      <footer className="mt-12 border-t border-app-bg-3/70 pt-5 text-xs text-app-fg-2">
        This is a snapshot of one conversation. Tool results, attachments, and later messages are
        not published.
      </footer>

      <TryAlfredBanner />
    </div>
  );
}

export function SharedThreadPage({ urlSlug }: { urlSlug: string }) {
  return (
    <AppThemeProvider>
      <AppThemed as="main" className="min-h-dvh bg-app-background">
        {/* Alt text instead of remote images, for the whole body, including later artifacts. */}
        <PublishedTranscript>
          <SharedThreadBody urlSlug={urlSlug} />
        </PublishedTranscript>
      </AppThemed>
    </AppThemeProvider>
  );
}
