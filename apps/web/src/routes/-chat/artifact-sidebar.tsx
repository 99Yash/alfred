import type { ArtifactFormat, ArtifactPage, ExternalFileContent } from "@alfred/contracts";
import type { SyncedArtifact } from "@alfred/sync";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
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
  type SetStateAction,
} from "react";
import { ArtifactCenteredState } from "~/components/artifacts/artifact-centered-state";
import { ArtifactIconButton } from "~/components/artifacts/artifact-icon-button";
import { ArtifactPagesBody } from "~/components/artifacts/artifact-pages-body";
import { ArtifactPresentOverlay } from "~/components/artifacts/artifact-present-overlay";
import { useArtifactPageIndex } from "~/components/artifacts/use-artifact-pages";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { printArtifactPages } from "~/lib/artifacts/export-artifact";
import type { LiveArtifactStream } from "~/lib/chat/use-artifact-stream";
import { useArtifact } from "~/lib/replicache/use-artifacts";
import { cn } from "~/lib/utils";
import type { ChatSidePanelMode } from "~/routes/-chat/rail/models";

/**
 * Artifact sidebar (ADR-0075 Phase 3): a `document` as markdown, `pages` as scaled iframes.
 * Replicache pokes on each authoring call, so pages appear while the boss is still `generating`.
 * Shares the shell's right-rail slot with the Today rail, in the same inline/overlay modes.
 */

export interface ArtifactEditSuggestion {
  artifactTargetId: string;
  text: string;
}

interface ArtifactSidebarProps {
  /** A synced row id, or `pending:<toolCallId>` while a create streams; then the body is all `liveStream`. */
  artifactId: string;
  /** The live authoring stream for a document, if it is being written now. Null for pages and idle rows. */
  liveStream?: LiveArtifactStream | null | undefined;
  mode: ChatSidePanelMode;
  /** Inline width in px; overlay ignores it. */
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onSuggestEdit?: ((suggestion: ArtifactEditSuggestion) => void) | undefined;
}

/** Body and labels. The live body wins while the boss writes; then the synced (sanitized) row. */
interface DocumentView {
  markdown: string;
  /** Drives the "Writing…" state. */
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

  // Live while authoring or before a create's row syncs.
  // A finished append stays live until the synced row ends with its section, so it does not blink out.
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

  // Shared by the strip, the present button, and the overlay, so presenting starts on the current page.
  const [pageIndex, setPageIndex] = useArtifactPageIndex(artifactId);

  // Escape exits fullscreen first, then closes the overlay. Effect Event, so the listener mounts once.
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
  const isExternalFile = artifact?.kind === "external_file";

  // A pending create has no row yet; pages never stream, so it is a document.
  const isDocument =
    !isPages && !isExternalFile && (artifact?.kind === "document" || liveStream != null);

  const documentView = resolveDocumentView(artifact, liveStream);
  const title = artifact?.title ?? liveStream?.title ?? "Artifact";

  // In overlay mode the panel covers the composer, so close it first.
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
        onEdit={onSuggestEdit && !isExternalFile ? onEdit : undefined}
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
            "fixed inset-y-0 right-0 z-50 w-[560px] max-w-[92vw]",
            "border-l border-app-bg-3/60 bg-app-bg-1",
            "flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
            "animate-artifact-panel",
          )}
        >
          {inner}
        </aside>
        {fullscreen && artifact ? (
          <ArtifactPresentOverlay
            title={artifact.title}
            pages={artifact.content?.kind === "pages" ? artifact.content.pages : []}
            format={artifact.format ?? "pdf"}
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
        <ArtifactPresentOverlay
          title={artifact.title}
          pages={artifact.content?.kind === "pages" ? artifact.content.pages : []}
          format={artifact.format ?? "pdf"}
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
  onFullscreen?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onClose: () => void;
}) {
  const isPages = artifact?.kind === "pages";
  const pagesContent = artifact?.content?.kind === "pages" ? artifact.content.pages : null;
  const pageCount = pagesContent?.length;
  const externalFile = artifact?.content?.kind === "external_file" ? artifact.content : null;

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
      {externalFile?.webViewLink ? (
        <a
          href={externalFile.webViewLink}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${artifact?.title ?? "file"} in Drive`}
          className="grid size-8 place-items-center rounded-lg text-app-fg-3 transition-colors hover:bg-app-bg-a2 hover:text-app-fg-4"
        >
          <ExternalLink size={14} />
        </a>
      ) : null}
      {onEdit && artifact && artifact.status !== "generating" && !documentView.generating ? (
        <ArtifactIconButton label="Suggest an edit" onClick={onEdit}>
          <Pencil size={13} />
        </ArtifactIconButton>
      ) : null}
      {canFullscreen && onFullscreen ? (
        <ArtifactIconButton label="Present fullscreen" onClick={onFullscreen}>
          <Maximize2 size={14} />
        </ArtifactIconButton>
      ) : null}
      <ArtifactIconButton label="Close artifact" onClick={onClose}>
        <X size={14} />
      </ArtifactIconButton>
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
  // A live document may have no synced row to read `generating` from.
  if (isDocument && documentView.generating) {
    return (
      <>
        <Loader2 size={12} className="animate-spin text-app-fg-3" />
        <span>Writing…</span>
      </>
    );
  }

  if (!artifact) return <span>Loading…</span>;

  // External files are complete at mint, so skip the lifecycle states.
  if (artifact.content?.kind === "external_file") {
    const { source, mimeType } = artifact.content;
    const sourceLabel = source === "drive" ? "Google Drive" : source;

    return <span>{mimeType ? `${sourceLabel} · ${mimeType}` : sourceLabel}</span>;
  }

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
  if (isDocument) {
    const markdown = documentView.markdown;

    if (markdown.trim().length === 0) {
      return documentView.generating ? (
        <ArtifactCenteredState
          icon={<Loader2 size={20} className="animate-spin" />}
          text="Writing…"
        />
      ) : (
        <ArtifactCenteredState icon={<FileText size={20} />} text="Empty document." />
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
      <ArtifactCenteredState
        icon={<Loader2 size={20} className="animate-spin" />}
        text="Loading artifact…"
      />
    );

  if (artifact.content?.kind === "external_file") {
    return <ExternalFileBody content={artifact.content} title={artifact.title} />;
  }

  // kind === "pages"
  const content = artifact.content;
  const pages: ArtifactPage[] = content?.kind === "pages" ? content.pages : [];

  return (
    <ArtifactPagesBody
      pages={pages}
      format={artifact.format ?? "pdf"}
      generating={artifact.status === "generating"}
      onPresent={onFullscreen}
      pageIndex={pageIndex}
      onPageIndexChange={onPageIndexChange}
    />
  );
}

/**
 * Hosts allowed into the `allow-scripts allow-same-origin` frame. Drive `/preview` needs both.
 * Safe only because the frame is cross-origin. `previewUrl` is any URL, so check the host.
 */
const TRUSTED_PREVIEW_HOSTS = new Set(["drive.google.com", "docs.google.com"]);

function isTrustedPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" && TRUSTED_PREVIEW_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * A Drive file the agent could not read, shown so the user can view or download it (#287).
 * The remote preview frame mounts only for {@link isTrustedPreviewUrl}; else just "Open in Drive".
 * React Doctor flags the sandbox combo; the host check is the guard.
 */
function ExternalFileBody({ content, title }: { content: ExternalFileContent; title: string }) {
  const previewTrusted = isTrustedPreviewUrl(content.previewUrl);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {previewTrusted ? (
        <iframe
          title={title}
          src={content.previewUrl}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
          className="min-h-0 flex-1 border-0 bg-app-bg-a2"
          allow="autoplay"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-app-bg-a2 px-6 text-center">
          <FileText size={24} className="text-app-fg-3" />
          <p className="text-[13px] text-app-fg-3">
            Preview isn’t available here. Use the link below to open this file.
          </p>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-app-bg-3/50 px-4 py-2.5 text-[12px] text-app-fg-3">
        <FileText size={13} className="shrink-0" />
        <span className="truncate">
          {content.fileName ?? title}
          {content.mimeType ? ` · ${content.mimeType}` : ""}
        </span>
        {content.webViewLink ? (
          <a
            href={content.webViewLink}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-app-fg-4 transition-colors hover:bg-app-bg-a2"
          >
            Open in Drive
            <ExternalLink size={12} />
          </a>
        ) : null}
      </div>
    </div>
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
  const [dragging, setDragging] = useState(false);

  // Pointer capture, not window listeners: `pointermove` stops once the cursor enters an iframe.
  // Capture releases on its own at pointerup.
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      // Dragging left widens the panel. `onWidthChange` clamps.
      const delta = drag.current.startX - e.clientX;
      onWidthChange(drag.current.startWidth + delta);
    },
    [onWidthChange],
  );

  const endDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  return (
    // react-doctor wants <hr>, but an <hr> cannot be a drag splitter. Keep role="separator".
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize artifact panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      // ~10px hit target over the 1px rule; `touch-none` stops page scroll.
      className="group absolute inset-y-0 left-0 z-10 w-2.5 cursor-col-resize touch-none"
    >
      {/* Lit on press for the whole drag; group-hover alone flickers as the cursor leaves. */}
      <div
        className={cn(
          "absolute inset-y-0 left-0 w-px transition-colors",
          dragging ? "bg-app-purple-3" : "bg-app-bg-3/60 group-hover:bg-app-fg-3",
        )}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Small shared bits                                                           */
/* -------------------------------------------------------------------------- */

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
    <ArtifactIconButton label="Download PDF" onClick={busy ? undefined : onDownload}>
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
    </ArtifactIconButton>
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
    <ArtifactIconButton label={copied ? "Copied" : "Copy markdown"} onClick={onCopy}>
      {copied ? (
        <Check size={14} className="animate-check-pop text-emerald-500" />
      ) : (
        <Copy size={14} />
      )}
    </ArtifactIconButton>
  );
}
