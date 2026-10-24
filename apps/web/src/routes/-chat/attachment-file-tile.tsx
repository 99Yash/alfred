import { FileText } from "lucide-react";

/** "PDF", "TXT", "MD", "CSV" from the file name. A name with no short extension reads "FILE". */
function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";

  return extension.length > 0 && extension.length <= 4 ? extension.toUpperCase() : "FILE";
}

/**
 * The face of a PDF or text attachment, which has no image to show. `compact` fits the 64 px
 * composer chip (icon and type); the full tile fits the 160 px message tile and adds the name.
 */
export function AttachmentFileTile({ name, compact }: { name: string; compact?: boolean }) {
  const label = extensionLabel(name);

  if (compact) {
    return (
      <div title={name} className="flex size-full flex-col items-center justify-center gap-1">
        <FileText size={18} className="text-app-fg-3" aria-hidden />
        <span className="text-[10px] leading-none font-semibold tracking-wide text-app-fg-2">
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className="flex size-full flex-col justify-between p-3 text-left">
      <FileText size={20} className="text-app-fg-3" aria-hidden />
      <div className="min-w-0">
        <p
          title={name}
          className="line-clamp-3 text-[13px] leading-snug font-medium break-all text-app-fg-4"
        >
          {name}
        </p>
        <p className="mt-1 text-[11px] leading-none font-semibold tracking-wide text-app-fg-2">
          {label}
        </p>
      </div>
    </div>
  );
}
