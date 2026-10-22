import { MAX_ATTACHMENT_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { validateFile } from "~/lib/chat/upload-attachments";
import { toast } from "~/lib/toast";

/** A staged file with a local preview. */
export interface PendingAttachment {
  /** Local key; the real id is minted at upload. */
  key: string;
  file: File;
  /** Object URL for the thumbnail; revoked on removal or clear. */
  previewUrl: string;
}

export interface ComposerAttachments {
  items: PendingAttachment[];
  addFiles: (files: FileList | File[]) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** Stage `next` in place of the current files. Returns the files it took off, unchanged. */
  replace: (next: File[]) => File[];
  /** Raw files in staged order. */
  files: () => File[];
}

// The one place this hook allocates an object URL. The caller owns it from here on.
function stage(file: File): PendingAttachment {
  return { key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) };
}

/**
 * Composer attachment staging (ADR-0065). Bytes upload at send (`useSendMessage`).
 * `itemsRef` is the inventory and `items` is its render copy. Object URLs are revoked on
 * removal, clear, replace, and unmount.
 */
export function useComposerAttachments(): ComposerAttachments {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  // Event-time reads see every earlier change, committed or not. Only `commit` writes it.
  const itemsRef = useRef<PendingAttachment[]>([]);

  // Pass the computed list, never an updater: an updater lets `items` drift from the ref.
  const commit = useCallback((next: PendingAttachment[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  // Enforce the caps before upload too (the server also does). Check them before any
  // object URL exists. Allocate, revoke, and toast here, not in a `setItems` updater:
  // StrictMode can run updaters twice.
  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const valid: File[] = [];

      for (const file of Array.from(files)) {
        const err = validateFile(file);

        if (err) {
          toast.error(err);
          continue;
        }

        valid.push(file);
      }

      if (valid.length === 0) return;
      const current = itemsRef.current;
      const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length;

      if (room <= 0) {
        toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);

        return;
      }

      const accepted = valid.slice(0, room);

      if (accepted.length < valid.length) {
        toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
      }

      const acceptedBytes = accepted.reduce((sum, file) => sum + file.size, 0);
      const totalBytes = current.reduce((sum, item) => sum + item.file.size, 0) + acceptedBytes;

      if (totalBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
        const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
        toast.error(`Attachments can be up to ${mb} MB combined.`);

        return;
      }

      commit([...current, ...accepted.map(stage)]);
    },
    [commit],
  );

  const remove = useCallback(
    (key: string) => {
      const current = itemsRef.current;
      const target = current.find((a) => a.key === key);

      if (!target) return;
      URL.revokeObjectURL(target.previewUrl);
      commit(current.filter((a) => a.key !== key));
    },
    [commit],
  );

  const clear = useCallback(() => {
    for (const a of itemsRef.current) URL.revokeObjectURL(a.previewUrl);
    commit([]);
  }, [commit]);

  // No validation: the files passed it when they were first staged.
  const replace = useCallback(
    (next: File[]) => {
      const prev = itemsRef.current;

      for (const a of prev) URL.revokeObjectURL(a.previewUrl);

      commit(next.map(stage));

      return prev.map((a) => a.file);
    },
    [commit],
  );

  const files = useCallback(() => itemsRef.current.map((a) => a.file), []);

  // Revokes URLs from a change whose render never committed, too.
  useEffect(
    () => () => {
      for (const a of itemsRef.current) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  return { items, addFiles, remove, clear, replace, files };
}
