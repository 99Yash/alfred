import type { ArtifactFormat, ArtifactPage } from "@alfred/contracts";
import type { SyncedArtifact } from "@alfred/sync";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Layers,
  Loader2,
  Maximize2,
  Pencil,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { printArtifactPages } from "~/lib/artifacts/export-artifact";
import type { LiveArtifactStream } from "~/lib/chat/use-artifact-stream";
import { useArtifact } from "~/lib/replicache/use-artifacts";
import { cn } from "~/lib/utils";
import type { ChatSidePanelMode } from "~/routes/-chat/rail/models";

/**
 * The chat's artifact sidebar (ADR-0075 Phase 3). Renders a single synced
 * `artifacts` row inline beside the conversation: a `document` artifact as
 * markdown, a `pages` artifact as scaled iframe pages with a thumbnail strip
 * and a fullscreen presentation mode. Content arrives live via Replicache —
 * each authoring tool call rewrites the row and pokes, so pages appear at page
 * granularity while the boss is still `generating`.
 *
 * Layout mirrors the Today rail's two modes (`useRailMode`): `inline` takes a
 * resizable column next to the conversation; `overlay` slides in over it with a
 * backdrop on narrow viewports. The two share the shell's single right-rail
 * slot — opening an artifact swaps the rail out (see `chat-shell`).
 */

export interface ArtifactEditSuggestion {
  artifactTargetId: string;
  text: string;
}

interface ArtifactSidebarProps {
  /**
   * The open artifact. A real synced row id, or `pending:<toolCallId>` while a
   * `create_artifact` is still streaming and has no durable row yet — in which
   * case the body comes entirely from `liveStream`.
   */
  artifactId: string;
  /**
   * The boss's live authoring stream for this document, if it's being written
   * right now. Fills the body token-by-token ahead of (create) or over
   * (update/append) the synced row; the panel reconciles to the synced row once
   * the tool completes. Null for pages and for idle synced artifacts.
   */
  liveStream?: LiveArtifactStream | null;
  mode: ChatSidePanelMode;
  /** Inline-mode width in px (ignored in overlay mode). */
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  /** Prefill the composer with an edit scaffold for this artifact. */
  onSuggestEdit?: (suggestion: ArtifactEditSuggestion) => void;
}

/**
 * The document body + labels the sidebar renders, resolved from the synced row
 * and the live authoring stream. While the boss writes, the live body wins so
 * the panel fills as tokens arrive; once the tool completes we fall back to the
 * synced row (server-sanitized, and the source for future edits).
 */
interface DocumentView {
  /** Rendered markdown (live while streaming, synced once settled). */
  markdown: string;
  /** True while the body is still being authored — drives the "Writing…" state. */
  generating: boolean;
}

function resolveDocumentView(
  artifact: SyncedArtifact | null,
  liveStream: LiveArtifactStream | null | undefined,
): DocumentView {
  const syncedMarkdown =
    artifact?.kind === "document" && artifact.content?.kind === "document"
      ? artifact.content.markdown
      : "";
  const streaming = liveStream != null && !liveStream.done;
  // Show the live body while authoring, or when a create's row hasn't synced
  // yet (done but no synced content). `append` renders after existing content.
  // A just-finished append also stays live until the synced row actually carries
  // its section (endsWith), so the section doesn't blink out between the tool's
  // succeeded event and the Replicache poke landing.
  const appendPendingSync =
    liveStream != null &&
    liveStream.mode === "append" &&
    syncedMarkdown.length > 0 &&
    !syncedMarkdown.endsWith(liveStream.text);
  const showLive =
    liveStream != null && (streaming || syncedMarkdown.length === 0 || appendPendingSync);
  if (showLive) {
    const body =
      liveStream.mode === "append" && syncedMarkdown.length > 0
        ? `${syncedMarkdown}\n\n${liveStream.text}`
        : liveStream.text;
    return { markdown: body, generating: streaming || artifact?.status === "generating" };
  }
  return { markdown: syncedMarkdown, generating: artifact?.status === "generating" };
}

export function ArtifactSidebar({
  artifactId,
  liveStream,
  mode,
  width,
  onWidthChange,
  onClose,
  onSuggestEdit,
}: ArtifactSidebarProps) {
  const artifact = useArtifact(artifactId);
  const [fullscreen, setFullscreen] = useState(false);
  // Which page is in view. Lifted here so it is the single source of truth
  // shared by the thumbnail strip, the header's "present" button, and the
  // fullscreen viewer — so opening fullscreen starts on the page the user is
  // actually looking at, not page 1. The index is stored against the artifact it
  // belongs to, so swapping artifacts derives back to page 0 on its own — no
  // prop-sync effect (which would briefly show the previous artifact's index).
  const [pageState, setPageState] = useState<{ forId: string; index: number }>({
    forId: artifactId,
    index: 0,
  });
  const pageIndex = pageState.forId === artifactId ? pageState.index : 0;
  const setPageIndex = useCallback<Dispatch<SetStateAction<number>>>(
    (action) =>
      setPageState((s) => {
        const current = s.forId === artifactId ? s.index : 0;
        const next = typeof action === "function" ? action(current) : action;
        return { forId: artifactId, index: next };
      }),
    [artifactId],
  );

  // Escape closes the panel (overlay) or exits fullscreen first. The handler
  // reads the latest fullscreen/mode/onClose through an Effect Event so the
  // listener mounts once and never re-subscribes on a parent re-render.
  const onEscape = useEffectEvent(() => {
    if (fullscreen) setFullscreen(false);
    else if (mode === "overlay") onClose();
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const isPages = artifact?.kind === "pages";
  // A pending create has no synced row yet — the live stream is always a
  // document (pages never stream), so treat it as one for the whole panel.
  const isDocument = !isPages && (artifact?.kind === "document" || liveStream != null);
  const documentView = resolveDocumentView(artifact, liveStream);
  const title = artifact?.title ?? liveStream?.title ?? "Artifact";

  // "Suggest an edit" hands the boss a scaffold in the composer. On overlay
  // (narrow) the panel covers the composer, so close it first — the user lands
  // on the focused composer with the scaffold inserted.
  const onEdit = useCallback(() => {
    if (!artifact || !onSuggestEdit) return;
    onSuggestEdit({ artifactTargetId: artifact.id, text: "Edit this artifact: " });
    if (mode === "overlay") onClose();
  }, [artifact, onSuggestEdit, mode, onClose]);

  const inner = (
    <div className="flex h-full flex-col overflow-hidden">
      <ArtifactHeader
        artifact={artifact}
        title={title}
        isDocument={isDocument}
        documentView={documentView}
        canFullscreen={isPages}
        onFullscreen={isPages ? () => setFullscreen(true) : undefined}
        onEdit={onSuggestEdit ? onEdit : undefined}
        onClose={onClose}
      />
      <ArtifactBody
        artifact={artifact}
        isDocument={isDocument}
        documentView={documentView}
        onFullscreen={isPages ? () => setFullscreen(true) : null}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
      />
    </div>
  );

  if (mode === "overlay") {
    return (
      <>
        <button
          type="button"
          aria-label="Close artifact"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-app-background/40 backdrop-blur-[2px]"
        />
        <aside
          aria-label={title}
          className={cn(
            "fixed top-0 right-0 bottom-0 z-50 w-[560px] max-w-[92vw]",
            "border-l border-app-bg-3/60 bg-app-bg-1",
            "flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
            "animate-artifact-panel",
          )}
        >
          {inner}
        </aside>
        {fullscreen && artifact ? (
          <ArtifactFullscreen
            artifact={artifact}
            index={pageIndex}
            onIndexChange={setPageIndex}
            onClose={() => setFullscreen(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <aside
      aria-label={artifact?.title ?? "Artifact"}
      style={{ width }}
      className={cn(
        "relative h-full shrink-0",
        "overflow-hidden rounded-2xl border border-app-bg-3/60 bg-app-bg-1",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
        "animate-artifact-panel",
      )}
    >
      <ResizeHandle width={width} onWidthChange={onWidthChange} />
      {inner}
      {fullscreen && artifact ? (
        <ArtifactFullscreen
          artifact={artifact}
          index={pageIndex}
          onIndexChange={setPageIndex}
          onClose={() => setFullscreen(false)}
        />
      ) : null}
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

function ArtifactHeader({
  artifact,
  title,
  isDocument,
  documentView,
  canFullscreen,
  onFullscreen,
  onEdit,
  onClose,
}: {
  artifact: SyncedArtifact | null;
  title: string;
  isDocument: boolean;
  documentView: DocumentView;
  canFullscreen: boolean;
  onFullscreen?: () => void;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const isPages = artifact?.kind === "pages";
  const pagesContent = artifact?.content?.kind === "pages" ? artifact.content.pages : null;
  const pageCount = pagesContent?.length;

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-app-bg-3/50 px-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-app-bg-a2 text-app-fg-3">
        {isPages ? <Layers size={16} /> : <FileText size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium text-app-fg-4">{title}</h2>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-app-fg-3">
          <ArtifactSubline
            artifact={artifact}
            isDocument={isDocument}
            documentView={documentView}
            pageCount={pageCount}
          />
        </p>
      </div>
      {isDocument && !documentView.generating && documentView.markdown.length > 0 ? (
        <CopyMarkdownButton markdown={documentView.markdown} />
      ) : null}
      {isPages && pagesContent && pagesContent.length > 0 && artifact?.status !== "generating" ? (
        <DownloadPagesButton
          pages={pagesContent}
          format={artifact?.format ?? "pdf"}
          title={artifact?.title || "Artifact"}
        />
      ) : null}
      {onEdit && artifact && artifact.status !== "generating" && !documentView.generating ? (
        <IconButton label="Suggest an edit" onClick={onEdit}>
          <Pencil size={13} />
        </IconButton>
      ) : null}
      {canFullscreen && onFullscreen ? (
        <IconButton label="Present fullscreen" onClick={onFullscreen}>
          <Maximize2 size={14} />
        </IconButton>
      ) : null}
      <IconButton label="Close artifact" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </header>
  );
}

function ArtifactSubline({
  artifact,
  isDocument,
  documentView,
  pageCount,
}: {
  artifact: SyncedArtifact | null;
  isDocument: boolean;
  documentView: DocumentView;
  pageCount: number | undefined;
}) {
  // A document being authored (live stream, maybe no synced row yet) shows the
  // writing state directly — there's no `generating` synced row to key off.
  if (isDocument && documentView.generating) {
    return (
      <>
        <Loader2 size={12} className="animate-spin text-app-fg-3" />
        <span>Writing…</span>
      </>
    );
  }
  if (!artifact) return <span>Loading…</span>;
  const kindLabel =
    artifact.kind === "pages"
      ? artifact.format === "slides"
        ? "Slides"
        : "PDF document"
      : "Document";
  if (artifact.status === "generating") {
    return (
      <>
        <Loader2 size={12} className="animate-spin text-app-fg-3" />
        <span>
          Generating
          {pageCount !== undefined ? ` · ${pageCount} ${pageCount === 1 ? "page" : "pages"}` : ""}
        </span>
      </>
    );
  }
  if (artifact.status === "error") {
    return (
      <>
        <AlertTriangle size={12} className="text-amber-500" />
        <span>Generation incomplete</span>
      </>
    );
  }
  return (
    <span>
      {kindLabel}
      {pageCount !== undefined ? ` · ${pageCount} ${pageCount === 1 ? "page" : "pages"}` : ""}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Body                                                                        */
/* -------------------------------------------------------------------------- */

function ArtifactBody({
  artifact,
  isDocument,
  documentView,
  onFullscreen,
  pageIndex,
  onPageIndexChange,
}: {
  artifact: SyncedArtifact | null;
  isDocument: boolean;
  documentView: DocumentView;
  onFullscreen: (() => void) | null;
  pageIndex: number;
  onPageIndexChange: Dispatch<SetStateAction<number>>;
}) {
  // Document path covers a live-authoring create (no synced row yet) as well as
  // a synced document; the body comes from `documentView` either way.
  if (isDocument) {
    const markdown = documentView.markdown;
    if (markdown.trim().length === 0) {
      return documentView.generating ? (
        <CenteredState icon={<Loader2 size={20} className="animate-spin" />} text="Writing…" />
      ) : (
        <CenteredState icon={<FileText size={20} />} text="Empty document." />
      );
    }
    return (
      <div className="minimal-scrollbar flex-1 overflow-y-auto p-5">
        <MarkdownRenderer size="reading">{markdown}</MarkdownRenderer>
      </div>
    );
  }

  if (!artifact)
    return (
      <CenteredState
        icon={<Loader2 size={20} className="animate-spin" />}
        text="Loading artifact…"
      />
    );

  // kind === "pages"
  const content = artifact.content;
  const pages: ArtifactPage[] = content?.kind === "pages" ? content.pages : [];
  return (
    <PagesBody
      pages={pages}
      format={artifact.format ?? "pdf"}
      generating={artifact.status === "generating"}
      onFullscreen={onFullscreen}
      pageIndex={pageIndex}
      onPageIndexChange={onPageIndexChange}
    />
  );
}

function PagesBody({
  pages,
  format,
  generating,
  onFullscreen,
  pageIndex,
  onPageIndexChange,
}: {
  pages: ArtifactPage[];
  format: ArtifactFormat;
  generating: boolean;
  onFullscreen: (() => void) | null;
  pageIndex: number;
  onPageIndexChange: Dispatch<SetStateAction<number>>;
}) {
  // Clamp when the page list shrinks (e.g. an `update_artifact` replace).
  const safeIndex = pages.length === 0 ? 0 : Math.min(pageIndex, pages.length - 1);
  const current = pages[safeIndex];

  if (pages.length === 0) {
    return generating ? (
      <CenteredState icon={<Loader2 size={20} className="animate-spin" />} text="Creating pages…" />
    ) : (
      <CenteredState icon={<Layers size={20} />} text="No pages yet." />
    );
  }

  return (
    <>
      <div className="shrink-0 border-b border-app-bg-3/40 px-3 py-2">
        <div className="minimal-scrollbar flex gap-2 overflow-x-auto pb-1">
          {pages.map((page, index) => {
            const active = index === safeIndex;
            return (
              <button
                key={`${index}-${page.title}`}
                type="button"
                onClick={() => onPageIndexChange(index)}
                className={cn(
                  "w-[84px] shrink-0 rounded-xl border p-1 text-left transition-colors",
                  active
                    ? "border-app-fg-3 bg-app-bg-a2"
                    : "border-app-bg-3/60 bg-app-bg-a2/40 hover:bg-app-bg-a2",
                )}
              >
                <div className="overflow-hidden rounded-lg bg-white">
                  <ArtifactPageFrame
                    html={page.html}
                    title={`${page.title || `Page ${index + 1}`} thumbnail`}
                    format={format}
                    className="rounded-lg shadow-none"
                  />
                </div>
                <div className="mt-1 truncate text-[10px] text-app-fg-4">
                  {page.title || `Page ${index + 1}`}
                </div>
              </button>
            );
          })}
          {generating ? (
            <div className="grid w-[84px] shrink-0 place-items-center rounded-xl border border-dashed border-app-bg-3/60 bg-app-bg-a2/30 p-1">
              <Loader2 size={14} className="animate-spin text-app-fg-4" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="minimal-scrollbar flex-1 overflow-y-auto p-4">
        <button
          type="button"
          onClick={onFullscreen ?? undefined}
          aria-label="Present fullscreen"
          className="block w-full cursor-zoom-in"
        >
          {current ? (
            <ArtifactPageFrame
              html={current.html}
              title={current.title || `Page ${safeIndex + 1}`}
              format={format}
              className="ring-1 ring-app-bg-3/60"
            />
          ) : null}
        </button>
        <div className="mt-2 flex items-center justify-between text-[12px] text-app-fg-4">
          <span className="truncate">{current?.title || `Page ${safeIndex + 1}`}</span>
          <span>
            {safeIndex + 1} / {pages.length}
          </span>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Fullscreen presentation                                                     */
/* -------------------------------------------------------------------------- */

function ArtifactFullscreen({
  artifact,
  index,
  onIndexChange,
  onClose,
}: {
  artifact: SyncedArtifact;
  /** Current page, shared with the sidebar so entry/exit keep position. */
  index: number;
  onIndexChange: Dispatch<SetStateAction<number>>;
  onClose: () => void;
}) {
  const pages: ArtifactPage[] = artifact.content?.kind === "pages" ? artifact.content.pages : [];
  const format = artifact.format ?? "pdf";
  const safeIndex = pages.length === 0 ? 0 : Math.min(index, pages.length - 1);

  const go = useCallback(
    (delta: number) =>
      onIndexChange((i) => {
        const next = i + delta;
        if (next < 0) return 0;
        if (next > pages.length - 1) return Math.max(0, pages.length - 1);
        return next;
      }),
    [pages.length, onIndexChange],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(-1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [go]);

  // Lock background scroll while presenting.
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const current = pages[safeIndex];

  // Portal to `document.body`: the inline panel's `<aside>` carries a transform
  // (`animate-artifact-panel`), which would otherwise make this `fixed inset-0`
  // overlay resolve against the aside's box instead of the viewport.
  return createPortal(
    <div className="animate-artifact-fullscreen fixed inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm">
      <div className="flex h-12 shrink-0 items-center justify-between px-4 text-white/80">
        <span className="truncate text-sm">{artifact.title}</span>
        <div className="flex items-center gap-3">
          <span className="text-[12px] tabular-nums">
            {safeIndex + 1} / {pages.length}
          </span>
          <IconButton label="Exit fullscreen" onClick={onClose} tone="dark">
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-12 pb-8">
        <NavButton side="left" disabled={safeIndex === 0} onClick={() => go(-1)} />
        <div
          className={cn(
            "animate-artifact-fullscreen-content w-full",
            format === "slides" ? "max-w-[1100px]" : "max-w-[760px]",
          )}
        >
          {current ? (
            <ArtifactPageFrame
              html={current.html}
              title={current.title || `Page ${safeIndex + 1}`}
              format={format}
              className="shadow-2xl"
            />
          ) : null}
        </div>
        <NavButton side="right" disabled={safeIndex >= pages.length - 1} onClick={() => go(1)} />
      </div>
    </div>,
    document.body,
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous page" : "Next page"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full",
        "bg-white/10 text-white transition-colors hover:bg-white/20",
        "disabled:cursor-not-allowed disabled:opacity-30",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      {side === "left" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Resize handle (inline mode)                                                 */
/* -------------------------------------------------------------------------- */

function ResizeHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startWidth: width };
      const onMove = (ev: PointerEvent) => {
        if (!drag.current) return;
        // The panel sits on the right; its left edge is the handle, so dragging
        // left (clientX decreasing) widens it.
        const delta = drag.current.startX - ev.clientX;
        onWidthChange(drag.current.startWidth + delta);
      };
      const onUp = () => {
        drag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [width, onWidthChange],
  );

  return (
    // react-doctor's prefer-tag-over-role maps role="separator" → <hr>, but an
    // <hr> is a thematic break — it can't be an interactive drag splitter. The
    // ARIA separator role (with orientation + label) is the right semantics for
    // a resize handle, so the role stays. Same deliberate compromise as the
    // mention palette's role="menu".
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize artifact panel"
      onPointerDown={onPointerDown}
      className="group absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-col-resize"
    >
      <div className="absolute inset-y-0 left-0 w-px bg-app-bg-3/60 transition-colors group-hover:bg-app-fg-3" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Small shared bits                                                           */
/* -------------------------------------------------------------------------- */

function CenteredState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="grid flex-1 place-items-center px-8 text-center text-app-fg-4">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-12 place-items-center rounded-2xl bg-app-bg-a2 text-app-fg-3">
          {icon}
        </span>
        <p className="text-sm">{text}</p>
      </div>
    </div>
  );
}

function DownloadPagesButton({
  pages,
  format,
  title,
}: {
  pages: ArtifactPage[];
  format: ArtifactFormat;
  title: string;
}) {
  const [busy, setBusy] = useState(false);
  const onDownload = useCallback(() => {
    setBusy(true);
    void printArtifactPages(
      pages.map((page) => page.html),
      format,
      title,
    ).finally(() => setBusy(false));
  }, [pages, format, title]);
  return (
    <IconButton label="Download PDF" onClick={busy ? undefined : onDownload}>
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
    </IconButton>
  );
}

function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(markdown).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [markdown]);
  return (
    <IconButton label={copied ? "Copied" : "Copy markdown"} onClick={onCopy}>
      {copied ? (
        <Check size={14} className="animate-check-pop text-emerald-500" />
      ) : (
        <Copy size={14} />
      )}
    </IconButton>
  );
}

function IconButton({
  label,
  children,
  onClick,
  tone = "surface",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  tone?: "surface" | "dark";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-app-fg-3/40 focus-visible:outline-none",
        tone === "dark"
          ? "text-white/70 hover:bg-white/10 hover:text-white"
          : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
      )}
    >
      {children}
    </button>
  );
}
