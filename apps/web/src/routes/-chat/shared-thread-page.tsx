import type { SharedThreadArtifact, SharedThreadMessage } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, FileText, Layers, Loader2, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { AppThemed, AppThemeProvider } from "~/components/ui/v2";
import { FrostButton } from "~/components/landing/frost-button";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { MessageBubble } from "./message-bubble";
import { useSharedThreadPage } from "~/lib/sharing/use-thread-sharing";
import { cn } from "~/lib/utils";

/**
 * The public read-only view of a shared thread — `/c/$slug` (ADR-0102).
 *
 * THIS SURFACE RUNS SIGNED OUT. It opens no Replicache and reads no session of
 * its own; its only data source is `GET /api/shared/:slug`, whose body is a
 * frozen snapshot. That isolation is deliberate — it is what keeps a visitor
 * from being one buggy hook away from the owner's live data, so resist pulling
 * a shell, a sidebar, or a synced hook in here.
 *
 * `AppShell` still wraps this route, because it wraps every route from
 * `__root`. What keeps it inert here is the `chromeless` set in
 * `lib/shell/app-shell.tsx`, which `/c/` is a member of: no chrome renders and,
 * more importantly, the shell's signed-out-visitor redirect to `/login` does
 * not fire. Drop that membership and this page is unreachable by the only
 * audience it has.
 *
 * It lives in `-chat/` because it is a second view of the chat feature, not a
 * feature of its own: it reuses `MessageBubble` so a published transcript keeps
 * the markdown, reasoning panel, and tool trail the owner saw, rather than
 * drifting into a second renderer. The folder is a module boundary, not the
 * trust boundary. The trust boundary is the list above — what this file mounts.
 *
 * `MessageBubble` is safe to mount signed out, and that is a property to keep
 * rather than assume. It has no Replicache dependency, and `ConnectNudgeRows`
 * returns before it asks for credentials when a message carries no bounce —
 * which a published message never does, because the snapshot drops
 * `connectNudge`. Any new authenticated read added below `MessageBubble` breaks
 * this page, and nothing in the build will say so.
 */

/**
 * The one outbound control on this page.
 *
 * `FrostButton` renders its own `<button>` and has no `asChild`, so this
 * navigates on click rather than wrapping a router `Link` — a `<button>` inside
 * an `<a>` is invalid. That is the same trade `landing-cta-section.tsx` already
 * makes for the landing hero, and following it keeps one frost recipe in the
 * tree instead of a second hand-rolled copy on an anchor.
 */
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
 * The signed-out invitation, docked where a reader with an account would find
 * the composer. Adapted from Dimension's shared-thread banner, which puts the
 * product mark, one welcome line, and the action in a frosted pill that the
 * transcript scrolls under.
 *
 * The copy is deliberately NOT Dimension's "Create an account to start
 * chatting". That promise belongs to its `/copy` fork path, which Alfred does
 * not build (ADR-0102) — a visitor here cannot continue this conversation, and
 * an invitation that implies otherwise would be a lie the next click exposes.
 *
 * The action leaves for `/`. It does not open a sign-in: this page holds no
 * session and starting an auth flow from it would undo that.
 */
function TryAlfredBanner() {
  return (
    <div className="sticky bottom-0 z-10 -mx-5 mt-8 px-5 pb-4">
      {/* Fades the transcript out under the pill rather than cutting it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-full h-16 bg-gradient-to-b from-transparent to-app-background"
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
 * Widen a published message to the shape `MessageBubble` reads.
 *
 * The absent fields are absent from the snapshot on purpose (see
 * `sharedThreadMessageSchema`), so they are filled with the values that mean
 * "nothing to render": `usage: null` draws no cost line, `errorKind: null`
 * draws the generic failure copy rather than naming an internal taxonomy, and
 * the ids are placeholders no branch of the renderer reads. `threadId` is the
 * one a caller might be tempted to make real — do not. `Conversation` uses it
 * to open Replicache subscriptions, which is exactly what this page must not
 * do, and `MessageBubble` never reads it.
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

function ArtifactPanel({ artifact }: { artifact: SharedThreadArtifact }) {
  const body =
    artifact.content?.kind === "document"
      ? artifact.content.markdown
      : // A `pages` artifact is ordered full-bleed HTML. Rendering foreign HTML
        // into this page would hand a published thread script execution on the
        // app's own origin, so the public view names the artifact and its page
        // count instead of inlining it.
        null;

  return (
    <section className="rounded-2xl border border-app-bg-3/70 bg-app-bg-1 p-5">
      <div className="mb-3 flex items-center gap-2">
        {artifact.kind === "pages" ? (
          <Layers size={14} aria-hidden className="text-app-fg-2" />
        ) : (
          <FileText size={14} aria-hidden className="text-app-fg-2" />
        )}
        <h2 className="truncate text-sm font-medium text-app-fg-4">{artifact.title}</h2>
      </div>
      {body !== null ? (
        <MarkdownRenderer size="compact" tone="surface">
          {body}
        </MarkdownRenderer>
      ) : (
        <p className="text-xs text-app-fg-2">
          {artifact.content?.kind === "pages"
            ? `${artifact.content.pages.length} page${artifact.content.pages.length === 1 ? "" : "s"} — open this thread in Alfred to view them.`
            : "This artifact has no published body."}
        </p>
      )}
    </section>
  );
}

/** Shared chrome for every non-populated state, so they all sit in the same frame. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">{children}</div>
    </div>
  );
}

function SharedThreadBody({ urlSlug }: { urlSlug: string }) {
  const query = useSharedThreadPage(urlSlug);
  const [showArtifacts, setShowArtifacts] = useState(false);

  const messages = useMemo(
    () => (query.data?.messages ?? []).map(toRenderableMessage),
    [query.data],
  );

  if (query.isPending) {
    return (
      <Centered>
        <Loader2 size={18} aria-hidden className="animate-spin text-app-fg-2" />
        <p className="text-sm text-app-fg-2">Loading shared thread&hellip;</p>
      </Centered>
    );
  }

  // A revoked link and a slug that never existed answer identically (both 404),
  // and so does this page — telling the two apart would confirm a guess.
  if (query.isError || !query.data) {
    return (
      <Centered>
        <Lock size={18} aria-hidden className="text-app-fg-2" />
        <h1 className="text-base font-medium text-app-fg-4">This link is not available</h1>
        <p className="text-sm text-app-fg-2">
          The thread was never shared, or its link has been revoked.
        </p>
        <TryAlfredButton>Go to Alfred</TryAlfredButton>
      </Centered>
    );
  }

  const { title, artifacts, sharedAt } = query.data;

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
          <MessageBubble key={message.id} message={message} />
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
        <SharedThreadBody urlSlug={urlSlug} />
      </AppThemed>
    </AppThemeProvider>
  );
}
