import { type BriefingGather, resolveBriefingReferences } from "@alfred/contracts";
import { Fragment, useMemo } from "react";
import { cn } from "~/lib/utils";
import { EntityChip } from "./entity-chip";

/**
 * Resolve composer prose to a plain string (no chips) — for compact contexts
 * like the timeline gist. Resolved tokens become their label; unresolved ones
 * (or any token when no gather is present) fall back to their inner id.
 */
export function briefingPlainText(markdown: string, gather: BriefingGather | null): string {
  if (!gather) return markdown.replace(/\[\[[a-z_]+:([^\]\s]+)\]\]/g, (_, id) => id);
  return resolveBriefingReferences(markdown, gather)
    .segments.map((segment) => (segment.kind === "text" ? segment.text : segment.label))
    .join("");
}

/**
 * Renders composer prose (`breaking_summary` or a section `body`) with its
 * opaque `[[<kind>:<id>]]` tokens resolved against the row's synced `gather`
 * (ADR-0049). Resolution runs client-side through the shared
 * `@alfred/contracts` resolver — the same truth the server email renderer uses.
 * Without a gather (older rows, never-composed slots) the prose still renders;
 * any tokens simply fall back to their inner label as text.
 */
export function BriefingProse({
  markdown,
  gather,
  className,
}: {
  markdown: string;
  gather: BriefingGather | null;
  className?: string;
}) {
  const segments = useMemo(
    () => (gather ? resolveBriefingReferences(markdown, gather).segments : null),
    [markdown, gather],
  );

  if (!segments) {
    return <p className={cn("whitespace-pre-wrap", className)}>{markdown}</p>;
  }

  return (
    <p className={cn("whitespace-pre-wrap", className)}>
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          <Fragment key={i}>{segment.text}</Fragment>
        ) : (
          <EntityChip
            key={i}
            kind={segment.referenceKind}
            label={segment.label}
            href={segment.href}
          />
        ),
      )}
    </p>
  );
}
