import type { ArtifactFormat, ArtifactPage } from "@alfred/contracts";
import type { SyncedArtifact } from "@alfred/sync";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, Download, FileText, Layers, Loader2, Maximize2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ArtifactIconButton } from "~/components/artifacts/artifact-icon-button";
import { ArtifactPagesBody } from "~/components/artifacts/artifact-pages-body";
import { ArtifactPresentOverlay } from "~/components/artifacts/artifact-present-overlay";
import {
  useArtifactPageIndex,
  useArtifactPageKeys,
} from "~/components/artifacts/use-artifact-pages";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { AppButton } from "~/components/ui/v2";
import { printArtifactPages } from "~/lib/artifacts/export-artifact";
import { useArtifact, useRecentArtifacts } from "~/lib/replicache/use-artifacts";
import { cn } from "~/lib/utils";
import { artifactTypeLabel, formatArtifactDate } from "./helpers";

/**
 * The library's full-screen reader for one artifact, opened from a card at
 * `/library/$artifact`.
 *
 * A `pages` artifact renders through the same {@link ArtifactPagesBody} the chat
 * sidebar uses — thumbnail strip, one large page, click to present — so a deck
 * reads identically in both places. Page index and presentation state live here
 * rather than in the body, because Escape must exit the presentation before it
 * closes the viewer, and the two viewers must not both answer an arrow key.
 */
export function ArtifactViewer() {
  const { artifact: artifactId } = useParams({ from: "/library/$artifact" });
  const navigate = useNavigate();
  const subscribedArtifact = useArtifact(artifactId);
  const { artifacts, loading, error, initialPullPending, retry } = useRecentArtifacts();
  const artifact = subscribedArtifact ?? artifacts.find((row) => row.id === artifactId) ?? null;

  const [pageIndex, setPageIndex] = useArtifactPageIndex(artifactId);
  const [presenting, setPresenting] = useState(false);

  const pages: ArtifactPage[] = artifact?.content?.kind === "pages" ? artifact.content.pages : [];
  const canPresent = artifact?.kind === "pages" && pages.length > 0;

  const close = useCallback(() => {
    void navigate({ to: "/library" });
  }, [navigate]);

  // Escape exits the presentation first, then closes the viewer. The handler
  // reads the latest state through an Effect Event, so the listener mounts once.
  const onEscape = useEffectEvent(() => {
    if (presenting) setPresenting(false);
    else close();
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };

    window.addEventListener("keydown", handler);

    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Arrow keys page through the deck. Disabled while presenting, where the
  // overlay owns the same keys against the same index.
  useArtifactPageKeys({
    enabled: canPresent && !presenting,
    pageCount: pages.length,
    onIndexChange: setPageIndex,
  });

  if (!artifact) {
    if (loading || (initialPullPending && !error)) {
      return (
        <ArtifactDialog label="Loading artifact" onClose={close} compact>
          <ViewerState
            icon={<Loader2 size={22} className="animate-spin" />}
            title="Loading artifact"
          />
        </ArtifactDialog>
      );
    }

    if (error) {
      return (
        <ArtifactDialog label="Artifact loading error" onClose={close} compact>
          <ViewerState
            icon={<AlertTriangle size={22} />}
            title="Artifact could not be loaded"
            description={error}
            action={<AppButton onClick={retry}>Try again</AppButton>}
          />
        </ArtifactDialog>
      );
    }

    return (
      <ArtifactDialog label="Artifact not found" onClose={close} compact>
        <ViewerState
          icon={<FileText size={22} />}
          title="Artifact not found"
          description="It may no longer be included in your recent synced artifacts."
          action={
            <Link
              to="/library"
              className="text-xs text-app-fg-3 underline underline-offset-4 hover:text-app-fg-4"
            >
              Back to recent artifacts
            </Link>
          }
        />
      </ArtifactDialog>
    );
  }

  const format: ArtifactFormat = artifact.format ?? "pdf";

  return (
    <ArtifactDialog label={artifact.title} onClose={close}>
      <ArtifactHeader
        artifact={artifact}
        pages={pages}
        format={format}
        onPresent={canPresent ? () => setPresenting(true) : null}
        onClose={close}
      />

      {syncErrorBanner(error, retry)}

      <ArtifactBody
        artifact={artifact}
        pages={pages}
        format={format}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        onPresent={canPresent ? () => setPresenting(true) : null}
      />

      {presenting && canPresent ? (
        <ArtifactPresentOverlay
          title={artifact.title}
          pages={pages}
          format={format}
          index={pageIndex}
          onIndexChange={setPageIndex}
          onClose={() => setPresenting(false)}
        />
      ) : null}
    </ArtifactDialog>
  );
}

function syncErrorBanner(error: string | null, onRetry: () => void): ReactNode {
  if (!error) return null;

  return (
    <div className="mx-auto mt-4 flex w-full max-w-[720px] shrink-0 items-center justify-between gap-3 rounded-xl bg-app-bg-2 px-3 py-2 text-xs text-app-fg-3">
      <span>
        Showing a cached artifact. <span className="text-app-red-4">{error}</span>
      </span>
      <button type="button" onClick={onRetry} className="shrink-0 font-medium hover:underline">
        Retry
      </button>
    </div>
  );
}

function ArtifactHeader({
  artifact,
  pages,
  format,
  onPresent,
  onClose,
}: {
  artifact: SyncedArtifact;
  pages: ArtifactPage[];
  format: ArtifactFormat;
  onPresent: (() => void) | null;
  onClose: () => void;
}) {
  const isPages = artifact.kind === "pages";
  const canDownload = isPages && pages.length > 0 && artifact.status !== "generating";

  const onDownload = useCallback(() => {
    void printArtifactPages(
      pages.map((page) => page.html),
      format,
      artifact.title,
    );
  }, [pages, format, artifact.title]);

  return (
    <header className="flex min-h-[60px] shrink-0 items-center justify-between gap-4 px-4 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-app-bg-a2 text-app-fg-3">
          {isPages ? <Layers size={16} /> : <FileText size={16} />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-app-fg-4">{artifact.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-app-fg-3">
            {artifact.status === "generating" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : artifact.status === "error" ? (
              <AlertTriangle size={12} />
            ) : null}
            <span>
              {artifactTypeLabel(artifact)} · {formatArtifactDate(artifact)}
              {isPages && pages.length > 0
                ? ` · ${pages.length} ${pages.length === 1 ? "page" : "pages"}`
                : ""}
            </span>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canDownload ? (
          <ArtifactIconButton label="Download artifact" onClick={onDownload}>
            <Download size={14} />
          </ArtifactIconButton>
        ) : null}
        {onPresent ? (
          <ArtifactIconButton label="Present fullscreen" onClick={onPresent}>
            <Maximize2 size={14} />
          </ArtifactIconButton>
        ) : null}
        <button
          type="button"
          aria-label="Close artifact"
          onClick={onClose}
          className={cn(
            "grid size-8 place-items-center rounded-full bg-app-bg-2 text-app-fg-3",
            "transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          )}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}

function ArtifactBody({
  artifact,
  pages,
  format,
  pageIndex,
  onPageIndexChange,
  onPresent,
}: {
  artifact: SyncedArtifact;
  pages: ArtifactPage[];
  format: ArtifactFormat;
  pageIndex: number;
  onPageIndexChange: Dispatch<SetStateAction<number>>;
  onPresent: (() => void) | null;
}) {
  const generating = artifact.status === "generating";

  if (artifact.kind === "document") {
    const markdown = artifact.content?.kind === "document" ? artifact.content.markdown : "";

    if (!markdown.trim()) {
      return (
        <ViewerState
          icon={generating ? <Loader2 className="animate-spin" /> : <FileText />}
          title={generating ? "Writing document" : "This document is empty"}
        />
      );
    }

    return (
      <main className="scroll-stable min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <article className="mx-auto w-full max-w-[720px] rounded-2xl bg-app-bg-1 p-6 shadow-[0_8px_24px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.06)] sm:p-10">
          <MarkdownRenderer size="reading">{markdown}</MarkdownRenderer>
        </article>
      </main>
    );
  }

  if (pages.length === 0) {
    return (
      <ViewerState
        icon={generating ? <Loader2 className="animate-spin" /> : <Layers />}
        title={generating ? "Creating pages" : "This artifact has no pages"}
      />
    );
  }

  return (
    <ArtifactPagesBody
      pages={pages}
      format={format}
      generating={generating}
      pageIndex={pageIndex}
      onPageIndexChange={onPageIndexChange}
      onPresent={onPresent}
      className="min-h-0"
      pageClassName={format === "slides" ? "max-w-[1100px]" : "max-w-[760px]"}
    />
  );
}

function ArtifactDialog({
  label,
  onClose,
  compact = false,
  children,
}: {
  label: string;
  onClose: () => void;
  compact?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    // `size-full` is load-bearing: the UA stylesheet sizes a `<dialog>` with
    // `width/height: fit-content`, which `inset-0` alone cannot override (an
    // over-constrained box keeps the width and drops `right`). Without it the
    // viewer collapses to the width of its own header.
    <dialog
      open
      aria-modal="true"
      aria-label={label}
      className={cn(
        "app-fade-in fixed inset-0 z-[60] m-0 flex size-full max-h-none max-w-none",
        "overflow-hidden border-0 bg-transparent p-0",
        compact ? "items-center justify-center" : "flex-col",
      )}
    >
      <button
        type="button"
        aria-label="Close artifact"
        onClick={onClose}
        // Near-opaque, not translucent: the library grid behind stays legible
        // through an 88% wash, and a deck read over rows of chat titles is the
        // noise this viewer exists to remove.
        className="absolute inset-0 -z-10 bg-app-background/97 backdrop-blur-xl"
      />
      {compact ? (
        <div className="w-[min(420px,92vw)] rounded-2xl bg-app-bg-1 p-6 shadow-[0_24px_64px_rgba(0,0,0,0.20),0_0_0_1px_rgba(0,0,0,0.06)]">
          {children}
        </div>
      ) : (
        children
      )}
      {compact ? null : (
        <div className="pointer-events-none absolute right-5 bottom-4 text-[11.5px] text-app-fg-2">
          Esc to exit
        </div>
      )}
    </dialog>
  );
}

function ViewerState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="grid min-h-[220px] flex-1 place-items-center text-center">
      <div className="flex max-w-sm flex-col items-center">
        <span className="text-app-fg-3">{icon}</span>
        <p className="mt-3 text-sm font-medium text-app-fg-4">{title}</p>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-app-fg-3">{description}</p>
        ) : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}
