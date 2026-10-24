/**
 * Full-screen preview for the images of one message or one staged composer list.
 * Composes Radix Dialog primitives itself: `DialogContent` always adds a `frost-popover` panel.
 *
 * The owner (one hook per host) applies the image predicate in one place and keeps the
 * selected attachment **key**. Hosts never index into the filtered list, so a PDF or a
 * pending row before an image cannot shift the preview to the wrong image.
 */

import { isPassThrough } from "@alfred/contracts";
import * as RadixDialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { ArtifactIconButton } from "~/components/artifacts/artifact-icon-button";
import { cn } from "~/lib/utils";

/** One image the lightbox can show. */
interface LightboxImage {
  /** Attachment id (sent) or staging key (composer). */
  key: string;
  src: string;
  name: string;
}

/** One previewable candidate. The hook filters these down to images. */
interface LightboxCandidate extends LightboxImage {
  /** MIME type; only `isPassThrough` types enter the preview. */
  mime: string;
  /** False keeps the row out (for example, a pending sent attachment). Staged rows pass true. */
  ready: boolean;
}

/**
 * Open the preview at a key. Pass directly to `onClick`: the opener keeps the clicked
 * thumbnail so focus can return to it on close.
 */
export type AttachmentOpener = (event?: { currentTarget?: unknown }) => void;

/** Props for the file-local preview dialog, owned by {@link useAttachmentLightbox}. */
interface AttachmentLightboxProps {
  images: readonly LightboxImage[];
  selectedKey: string | null;
  dialogOpen: boolean;
  onClose: () => void;
  onSelectKey: (key: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}

/** One preview owner: an opener per key plus the rendered preview. */
interface AttachmentLightboxOwner {
  openerFor: (key: string) => AttachmentOpener | undefined;
  preview: ReactElement;
}

const FADE = cn(
  "motion-safe:data-[state=open]:animate-[dialog-overlay-in_180ms_cubic-bezier(0.2,0,0,1)]",
  "motion-safe:data-[state=closed]:animate-[dialog-overlay-out_140ms_cubic-bezier(0.2,0,0,1)]",
);

/**
 * Owns one preview: filters `candidates` to images, keeps the selected key, and hands
 * each host an opener per key plus the rendered preview.
 *
 * Close keeps the last key and only flips `open` off, so the Radix exit fade still has
 * the image and the focused control to fade. The key never falls back to `images[0]`.
 *
 * ```tsx
 * const lightbox = useAttachmentLightbox(candidates);
 * // per thumbnail: onOpen={lightbox.openerFor(a.id)}
 * {lightbox.preview}
 * ```
 */
export function useAttachmentLightbox(
  candidates: readonly LightboxCandidate[],
): AttachmentLightboxOwner {
  const images = useMemo<LightboxImage[]>(
    () =>
      candidates
        .filter((c) => c.ready && isPassThrough(c.mime))
        .map((c) => ({ key: c.key, src: c.src, name: c.name })),
    [candidates],
  );

  const [selection, setSelection] = useState<{ key: string | null; open: boolean }>({
    key: null,
    open: false,
  });

  const openerRef = useRef<HTMLElement | null>(null);

  const openerFor = useCallback(
    (key: string): AttachmentOpener | undefined => {
      if (!images.some((i) => i.key === key)) return undefined;

      return (event?: { currentTarget?: unknown }) => {
        const target = event?.currentTarget;
        openerRef.current =
          target instanceof HTMLElement
            ? target
            : document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        setSelection({ key, open: true });
      };
    },
    [images],
  );

  const onCloseAutoFocus = useCallback((event: Event) => {
    // Radix focuses its trigger ref, which is null here (no Dialog.Trigger), so focus
    // would drop to body. Return it to the thumbnail that opened the preview instead.
    event.preventDefault();
    const opener = openerRef.current;

    if (opener?.isConnected) opener.focus();
  }, []);

  const onClose = useCallback(() => {
    setSelection((s) => ({ key: s.key, open: false }));
  }, []);

  const onSelectKey = useCallback((key: string) => {
    setSelection({ key, open: true });
  }, []);

  const selectedKey = selection.key;
  const selectedIndex = selectedKey === null ? -1 : images.findIndex((i) => i.key === selectedKey);
  const dialogOpen = selection.open && selectedIndex !== -1;

  return {
    openerFor,
    preview: (
      <AttachmentLightbox
        images={images}
        selectedKey={selectedKey}
        dialogOpen={dialogOpen}
        onClose={onClose}
        onSelectKey={onSelectKey}
        onCloseAutoFocus={onCloseAutoFocus}
      />
    ),
  };
}

/** Full-screen image preview. File-local: hosts go through {@link useAttachmentLightbox}. */
function AttachmentLightbox({
  images,
  selectedKey,
  dialogOpen,
  onClose,
  onSelectKey,
  onCloseAutoFocus,
}: AttachmentLightboxProps): ReactElement {
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Resolve by key, never by render position: the image list skips PDFs and pending rows,
  // and a keyed selection follows its image if the list grows or reorders. The last key
  // stays set through the exit, so the fade still has the image and the focused control.
  const selectedIndex = selectedKey === null ? -1 : images.findIndex((i) => i.key === selectedKey);
  const image = selectedIndex === -1 ? undefined : images[selectedIndex];
  const multiple = images.length > 1;

  const go = (step: -1 | 1) => {
    if (!dialogOpen || selectedIndex === -1) return;
    const next = Math.max(0, Math.min(selectedIndex + step, images.length - 1));
    const nextImage = images[next];

    if (nextImage) onSelectKey(nextImage.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  // Only a click on the bare backdrop closes; the image and the controls do not.
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <RadixDialog.Root
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn("fixed inset-0 z-100 bg-black/70 backdrop-blur-[2px]", FADE)}
        />
        <RadixDialog.Content
          ref={contentRef}
          onOpenAutoFocus={(event) => {
            // Focus the surface, not the first tabbable node, so no focus ring shows on open.
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          onKeyDown={onKeyDown}
          onClick={onBackdropClick}
          className={cn(
            "app-media fixed inset-0 z-101 flex flex-col items-center justify-center gap-3 p-6 focus:outline-none",
            FADE,
          )}
        >
          {image ? (
            <>
              <RadixDialog.Title className="sr-only">{image.name}</RadixDialog.Title>
              <RadixDialog.Description className="sr-only">
                Image preview.{multiple ? " Use the arrow keys to see the other images." : null}
              </RadixDialog.Description>

              <div className="absolute top-3 right-3 flex items-center gap-1">
                <a
                  href={image.src}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open in new tab"
                  title="Open in new tab"
                  className="grid size-7 shrink-0 place-items-center rounded-control-sm text-app-fg-a3 transition-colors hover:bg-app-bg-a3 hover:text-app-fg-4 focus-visible:ring-2 focus-visible:ring-app-fg-a2 focus-visible:outline-none"
                >
                  <ExternalLink size={15} />
                </a>
                <ArtifactIconButton label="Close preview" onClick={onClose}>
                  <X size={16} />
                </ArtifactIconButton>
              </div>

              {/* Keyed by image: a new selection mounts fresh, so a past load
                  failure never sticks and the next open retries. */}
              <LightboxFigure key={image.key} image={image} />

              <div className="flex items-center gap-3">
                {multiple ? (
                  <LightboxNavButton
                    side="left"
                    disabled={selectedIndex === 0}
                    onClick={() => go(-1)}
                  />
                ) : null}
                <div className="flex max-w-60 items-center gap-2 rounded-full bg-app-bg-a3 px-3 py-1 text-xs text-app-fg-a4">
                  <span className="truncate">{image.name}</span>
                  {multiple ? (
                    <span className="shrink-0 text-app-fg-a2 tabular-nums">
                      {selectedIndex + 1} / {images.length}
                    </span>
                  ) : null}
                </div>
                {multiple ? (
                  <LightboxNavButton
                    side="right"
                    disabled={selectedIndex >= images.length - 1}
                    onClick={() => go(1)}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * The shown image. Owns its own load failure, so a failure dies with the selection
 * instead of lingering keyed by `src` across later opens.
 */
function LightboxFigure({ image }: { image: LightboxImage }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <p className="text-sm text-app-fg-a3">Couldn't load this image.</p>;

  return (
    <img
      src={image.src}
      alt={image.name}
      className="max-h-[80vh] max-w-[90vw] rounded-surface object-contain shadow-2xl"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Prev/next with a `-m-3 p-3` hit buffer, so a near miss does not close the preview.
 * `aria-disabled` keeps the button focusable at the ends, so the dialog-scoped arrow
 * keys keep working; a focused button never becomes `disabled` and drops focus to `body`.
 */
function LightboxNavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <span className="-m-3 p-3">
      <button
        type="button"
        aria-label={side === "left" ? "Previous image" : "Next image"}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onClick();
        }}
        className={cn(
          "grid size-8 place-items-center rounded-full bg-app-bg-a3 text-app-fg-4 transition-colors",
          "focus-visible:ring-2 focus-visible:ring-app-fg-a2 focus-visible:outline-none",
          disabled ? "cursor-not-allowed opacity-30" : "hover:bg-app-bg-a4",
        )}
      >
        {side === "left" ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </span>
  );
}
