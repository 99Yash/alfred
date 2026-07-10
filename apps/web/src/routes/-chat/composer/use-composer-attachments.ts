import { MAX_ATTACHMENT_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { validateFile } from "~/lib/chat/upload-attachments";
import { toast } from "~/lib/toast";

/** A file staged in the composer, with a local preview, before send. */
export interface PendingAttachment {
  /** Local key for React + removal; the real attachment id is minted at upload. */
  key: string;
  file: File;
  /** Object URL for the inline preview thumbnail; revoked on removal/clear. */
  previewUrl: string;
}

export interface ComposerAttachments {
  items: PendingAttachment[];
  addFiles: (files: FileList | File[]) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** The raw files, in staged order, for the send handler. */
  files: () => File[];
}

/**
 * Composer-local attachment staging (ADR-0065). Holds picked files with object-
 * URL previews until send; validation rejects unsupported/oversized files with a
 * toast. The bytes upload at send time (see `useSendMessage`), so this only
 * tracks the pending selection — object URLs are revoked on removal, clear, and
 * unmount to avoid leaks.
 */
export function useComposerAttachments(): ComposerAttachments {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Cap the staged count/bytes *before* upload — the turn endpoint and server
  // mutator also enforce the caps, but bounding here means a user picking 11
  // images never uploads the 11th only to have the turn rejected. All revocation
  // + toasts happen here in the event handler (against the live `itemsRef`), so
  // the `setItems` updater stays pure — React can double-invoke updaters under
  // StrictMode, and revoking inside one would kill a preview that's still in use.
  const addFiles = useCallback((files: FileList | File[]) => {
    const candidates: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const err = validateFile(file);
      if (err) {
        toast.error(err);
        continue;
      }
      candidates.push({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) });
    }
    if (candidates.length === 0) return;
    const current = itemsRef.current;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length;
    if (room <= 0) {
      for (const a of candidates) URL.revokeObjectURL(a.previewUrl);
      toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
      return;
    }
    const accepted = candidates.slice(0, room);
    if (accepted.length < candidates.length) {
      for (const a of candidates.slice(room)) URL.revokeObjectURL(a.previewUrl);
      toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
    }
    const acceptedBytes = accepted.reduce((sum, item) => sum + item.file.size, 0);
    const totalBytes = current.reduce((sum, item) => sum + item.file.size, 0) + acceptedBytes;
    if (totalBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
      for (const a of accepted) URL.revokeObjectURL(a.previewUrl);
      const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
      toast.error(`Attachments can be up to ${mb} MB combined.`);
      return;
    }
    setItems((prev) => [...prev, ...accepted]);
  }, []);

  const remove = useCallback((key: string) => {
    const target = itemsRef.current.find((a) => a.key === key);
    if (target) URL.revokeObjectURL(target.previewUrl);
    setItems((prev) => prev.filter((a) => a.key !== key));
  }, []);

  const clear = useCallback(() => {
    for (const a of itemsRef.current) URL.revokeObjectURL(a.previewUrl);
    setItems([]);
  }, []);

  const files = useCallback(() => itemsRef.current.map((a) => a.file), []);

  // Revoke any still-staged previews on unmount.
  useEffect(
    () => () => {
      for (const a of itemsRef.current) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  return { items, addFiles, remove, clear, files };
}
