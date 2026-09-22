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
  liveStream?: LiveArtifactStream | null | undefined;
  mode: ChatSidePanelMode;
  /** Inline-mode width in px (ignored in overlay mode). */
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  /** Prefill the composer with an edit scaffold for this artifact. */
  onSuggestEdit?: ((suggestion: ArtifactEditSuggestion) => void) | undefined;
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
  // presentation overlay — so presenting starts on the page the user is actually
  // looking at, not page 1.
  const [pageIndex, setPageIndex] = useArtifactPageIndex(artifactId);

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
  const isExternalFile = artifact?.kind === "external_file";

  // A pending create has no synced row yet — the live stream is always a
  // document (pages never stream), so treat it as one for the whole panel.
  const isDocument =
    !isPages && !isExternalFile && (artifact?.kind === "document" || liveStream != null);

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

  // An external_file is minted `generating` (its content is complete at mint;
  // the run finalizer flips it + backfills messageId), so skip the lifecycle
  // states below — there is nothing to generate — and label it by source/type.
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
  // Document path covers a live-authoring create (no synced row yet) as well as
  // a synced document; the body comes from `documentView` either way.
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
 * Google preview origins we trust to receive `allow-scripts allow-same-origin`.
 * The Drive `/preview` viewer genuinely needs both — scripts to render, and its
 * own origin to read the user's Google session for private files. That combo is
 * only safe because the frame is CROSS-origin from Alfred (the browser's
 * same-origin policy blocks any sandbox escape into our origin). Since
 * `previewUrl` is provider metadata typed as an arbitrary `z.string().url()`,
 * we enforce the "it's really Google" assumption here rather than trusting it:
 * an Alfred-origin (or attacker-controlled) URL must never reach that scripted,
 * same-origin frame.
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
 * Render an existing external file inline (#287): a Drive file the agent
 * couldn't read/export, surfaced so the user can view + download it. The preview
 * is a REMOTE iframe (the provider's own `/preview` page) — a different, relaxed
 * sandbox from the locked `srcDoc` frame the authored `pages` kind uses, because
 * it loads a trusted third-party origin (Google) that needs its own scripts and
 * same-origin. `allow-same-origin` grants the framed Google page access to ITS
 * origin only, never Alfred's — and we only mount the frame when `previewUrl`
 * resolves to a trusted Google host (see {@link isTrustedPreviewUrl}); otherwise
 * we fall back to the "Open in Drive" link alone. (React Doctor still flags the
 * literal `allow-scripts`+`allow-same-origin` combo statically; that warning is
 * knowingly accepted here, guarded by the host check rather than suppressed.)
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
/* Fullscreen presentation                                                     */
/* -------------------------------------------------------------------------- */

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

  // Pointer *capture* (not window listeners) routes every move/up back to this
  // element even after the cursor crosses onto the artifact's iframes. A plain
  // window `pointermove` stops firing the instant the pointer enters an
  // `<iframe>` (the events go to the frame's own document), so dragging the
  // panel narrower — cursor moving in over the rendered pages — would freeze
  // mid-drag. Capture also removes the need to add/tear-down global listeners:
  // it auto-releases on pointerup / lostpointercapture.
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
      // The panel sits on the right; its left edge is the handle, so dragging
      // left (clientX decreasing) widens it. `onWidthChange` clamps the bounds.
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
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      // ~10px hit target (Apple's gesture guidance) over the 1px visual rule;
      // `touch-none` stops a touch-drag scrolling the page instead of resizing.
      className="group absolute inset-y-0 left-0 z-10 w-2.5 cursor-col-resize touch-none"
    >
      {/* Feedback lives on the press and stays lit for the whole drag (the
       * cursor leaves the hover zone as the panel resizes, so group-hover alone
       * would flicker the rule back to faint mid-gesture). */}
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
