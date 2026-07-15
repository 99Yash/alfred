import { pageGeometry } from "@alfred/artifacts-design/tokens";
import type { ArtifactFormat } from "@alfred/contracts";
import type { SyncedArtifact } from "@alfred/sync";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, Download, FileText, Layers, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { AppButton } from "~/components/ui/v2";
import { printArtifactPages } from "~/lib/artifacts/export-artifact";
import { useArtifact, useRecentArtifacts } from "~/lib/replicache/use-artifacts";
import { cn } from "~/lib/utils";
import { artifactTypeLabel, formatArtifactDate } from "./helpers";

export function ArtifactViewer() {
  const { artifact: artifactId } = useParams({ from: "/library/$artifact" });
  const navigate = useNavigate();
  const subscribedArtifact = useArtifact(artifactId);
  const { artifacts, loading, error, initialPullPending, retry } = useRecentArtifacts();
  const artifact = subscribedArtifact ?? artifacts.find((row) => row.id === artifactId) ?? null;

  const close = useCallback(() => {
    void navigate({ to: "/library" });
  }, [navigate]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);

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

  return (
    <PopulatedArtifact artifact={artifact} syncError={error} onRetry={retry} onClose={close} />
  );
}

function PopulatedArtifact({
  artifact,
  syncError,
  onRetry,
  onClose,
}: {
  artifact: SyncedArtifact;
  syncError: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const pages = artifact.content?.kind === "pages" ? artifact.content.pages : [];
  const canDownload =
    artifact.kind === "pages" && pages.length > 0 && artifact.status !== "generating";
  // The dialog scrolls inside this `<main>`, not the window. Lazy page mounting
  // roots its IntersectionObserver on this element so the gate tracks the real
  // scroller rather than the viewport.
  const scrollRef = useRef<HTMLElement | null>(null);

  const onDownload = useCallback(() => {
    if (!canDownload) return;
    const downloadablePages = artifact.content?.kind === "pages" ? artifact.content.pages : [];
    const format: ArtifactFormat = artifact.format ?? "pdf";
    void printArtifactPages(
      downloadablePages.map((page) => page.html),
      format,
      artifact.title,
    );
  }, [artifact.content, artifact.format, artifact.title, canDownload]);

  return (
    <ArtifactDialog label={artifact.title} onClose={onClose}>
      <header className="relative flex min-h-[60px] items-center justify-between gap-4 px-4 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] sm:px-6">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-app-fg-4">{artifact.title}</p>
          <p className="mt-0.5 text-[11.5px] text-app-fg-3">
            {artifactTypeLabel(artifact)} · {formatArtifactDate(artifact)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canDownload ? (
            <AppButton
              variant="ghost"
              size="md"
              aria-label="Download artifact"
              onClick={onDownload}
            >
              <Download size={15} />
            </AppButton>
          ) : null}
          <Link
            to="/library"
            aria-label="Close artifact"
            className={cn(
              "grid size-8 place-items-center rounded-full bg-app-bg-2 text-app-fg-3",
              "transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
            )}
          >
            <X size={15} />
          </Link>
        </div>
      </header>

      <main
        ref={scrollRef}
        className="scroll-stable relative min-h-0 flex-1 overflow-y-auto px-4 py-8"
      >
        {syncError ? (
          <div className="mx-auto mb-5 flex w-full max-w-[720px] items-center justify-between gap-3 rounded-xl bg-app-bg-2 px-3 py-2 text-xs text-app-fg-3">
            <span>
              Showing a cached artifact. <span className="text-app-red-4">{syncError}</span>
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 font-medium hover:underline"
            >
              Retry
            </button>
          </div>
        ) : null}
        <ArtifactStatus artifact={artifact} />
        <ArtifactContent artifact={artifact} scrollRef={scrollRef} />
      </main>

      <div className="pointer-events-none absolute right-5 bottom-4 text-[11.5px] text-app-fg-2">
        Esc to exit
      </div>
    </ArtifactDialog>
  );
}

function ArtifactStatus({ artifact }: { artifact: SyncedArtifact }) {
  if (artifact.status === "complete") return null;
  const generating = artifact.status === "generating";
  return (
    <div className="mx-auto mb-5 flex w-full max-w-[720px] items-center gap-2 rounded-xl bg-app-bg-2 px-3 py-2 text-xs text-app-fg-3">
      {generating ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
      {generating
        ? "This artifact is still generating."
        : "Generation ended before this artifact completed."}
    </div>
  );
}

function ArtifactContent({
  artifact,
  scrollRef,
}: {
  artifact: SyncedArtifact;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  if (artifact.kind === "document") {
    const markdown = artifact.content?.kind === "document" ? artifact.content.markdown : "";
    if (!markdown.trim()) {
      return (
        <ViewerState
          icon={
            artifact.status === "generating" ? <Loader2 className="animate-spin" /> : <FileText />
          }
          title={artifact.status === "generating" ? "Writing document" : "This document is empty"}
        />
      );
    }
    return (
      <article className="mx-auto w-full max-w-[720px] rounded-2xl bg-app-bg-1 p-6 shadow-[0_8px_24px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.06)] sm:p-10">
        <MarkdownRenderer size="reading">{markdown}</MarkdownRenderer>
      </article>
    );
  }

  const pages = artifact.content?.kind === "pages" ? artifact.content.pages : [];
  if (pages.length === 0) {
    return (
      <ViewerState
        icon={artifact.status === "generating" ? <Loader2 className="animate-spin" /> : <Layers />}
        title={artifact.status === "generating" ? "Creating pages" : "This artifact has no pages"}
      />
    );
  }
  const format = artifact.format ?? "pdf";
  const pageKeyOccurrences = new Map<string, number>();
  const keyedPages = pages.map((page) => {
    const shapeKey = JSON.stringify([page.title, page.html]);
    const occurrence = pageKeyOccurrences.get(shapeKey) ?? 0;
    pageKeyOccurrences.set(shapeKey, occurrence + 1);
    return { key: JSON.stringify([shapeKey, occurrence]), page };
  });
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
      {keyedPages.map(({ key, page }, index) => (
        <section key={key} aria-label={`Page ${index + 1}`}>
          <div className="mb-2 flex items-center justify-between text-[11.5px] text-app-fg-3">
            <span>{page.title || "Page"}</span>
            <span className="tabular-nums">
              {index + 1} / {pages.length}
            </span>
          </div>
          <LazyArtifactPage
            html={page.html}
            title={`${artifact.title} page ${index + 1}`}
            format={format}
            scrollRef={scrollRef}
          />
        </section>
      ))}
    </div>
  );
}

/**
 * Mount each page's sandboxed iframe only once it first scrolls into view (with a
 * small pre-margin), then keep it mounted. The live win TODAY is paint cost: a
 * long deck no longer spins up every sandboxed iframe on open, only the few near
 * the viewport. It is ALSO the seam for artifact motion (ADR-0086): the shell
 * defines autoplay-on-mount entrance classes, the only motion a `sandbox=""` +
 * `pointer-events: none` iframe can carry. That vocabulary is still dormant — not
 * yet named in the authoring prompt — so nothing animates yet; but once the
 * expression dial enables it, gating the mount on intersection makes
 * mount == reveal, so each page's entrance will fire as it arrives rather than
 * all at once on open. The seam is in place ahead of the vocabulary, not the
 * reverse.
 *
 * Until a page mounts we render a same-aspect placeholder so scroll height is
 * stable (the observer for later pages can fire) and the swap causes no layout
 * shift. The observer roots on the real scroll container (`scrollRef` -> the
 * dialog's `<main>`), not the viewport, so the gate stays correct if the viewer
 * layout ever nests that scroller; it falls back to the viewport (`null`) if the
 * ref is not attached yet. The observer lives in the parent app DOM, where JS is
 * allowed — the sealed iframe never sees it.
 */
function LazyArtifactPage({
  html,
  title,
  format,
  scrollRef,
}: {
  html: string;
  title: string;
  format: ArtifactFormat;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setMounted(true);
          observer.disconnect();
        }
      },
      // Root on the scroll container so the gate tracks the real scroller. A
      // small positive margin pre-mounts just before the page enters view so the
      // iframe has loaded by the time it is looked at, without spending the
      // entrance far off-screen.
      { root: scrollRef.current, rootMargin: "96px 0px", threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, scrollRef]);

  if (mounted) {
    return <ArtifactPageFrame html={html} title={title} format={format} />;
  }
  const { width, height } = pageGeometry[format];
  return (
    <div
      ref={ref}
      aria-hidden
      className="rounded-lg bg-app-bg-2 shadow-2xl"
      style={{ aspectRatio: `${width} / ${height}` }}
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
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <dialog
      open
      aria-modal="true"
      aria-label={label}
      className={cn(
        "app-fade-in fixed inset-0 z-[60] m-0 flex max-h-none max-w-none border-0 bg-transparent p-0",
        compact ? "items-center justify-center" : "flex-col",
      )}
    >
      <button
        type="button"
        aria-label="Close artifact"
        onClick={onClose}
        className="absolute inset-0 -z-10 bg-app-background/88 backdrop-blur-[6px]"
      />
      {compact ? (
        <div className="w-[min(420px,92vw)] rounded-2xl bg-app-bg-1 p-6 shadow-[0_24px_64px_rgba(0,0,0,0.20),0_0_0_1px_rgba(0,0,0,0.06)]">
          {children}
        </div>
      ) : (
        children
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
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid min-h-[220px] place-items-center text-center">
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
