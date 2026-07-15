import { z } from "zod";

/**
 * Agent-produced artifacts (ADR-0075). The boss authors an artifact — a
 * document or a deck/PDF of pages — via the `system.create_artifact` /
 * `append_artifact_page` / `update_artifact` tools; the content is stored in a
 * synced `artifacts` row (Postgres → Replicache) and rendered inline in the
 * chat's right-side artifact sidebar. Agent-authored HTML/markdown, NOT a
 * Google→PDF binary export (ADR-0070/0071 forbid inlining binary anyway).
 *
 * This file is the single source of truth for the artifact shapes. The DB
 * column binds via `.$type<>()`, the synced schema derives via `z.infer`, and
 * the renderer reads the same types — no hand-rolled duplicate shapes.
 */

/**
 * What the artifact *is*, which selects the renderer.
 *   - `document` — long-form prose; `content` is markdown.
 *   - `pages`    — an ordered set of full-bleed HTML pages (a deck or a
 *                  paginated doc); rendered in scaled sandboxed iframes.
 *   - `spreadsheet` — RESERVED (ADR-0075 defers it: needs a heavy grid lib). No
 *                  renderer or authoring tool ships in v1; the literal exists so
 *                  the union and DB CHECK don't churn when it lands.
 */
export const artifactKindValues = ["document", "pages", "spreadsheet"] as const;
export type ArtifactKind = (typeof artifactKindValues)[number];
export const artifactKindSchema = z.enum(artifactKindValues);

/**
 * For `kind: "pages"`, how to present the pages — drives aspect ratio and chrome
 * in the renderer. Null for non-paged kinds.
 *   - `slides` — 16:9 deck pages, fullscreen presentation mode available.
 *   - `pdf`    — portrait US-Letter (8.5×11) document pages.
 */
export const artifactFormatValues = ["slides", "pdf"] as const;
export type ArtifactFormat = (typeof artifactFormatValues)[number];
export const artifactFormatSchema = z.enum(artifactFormatValues);

/**
 * Lifecycle of an artifact as the boss authors it.
 *   - `generating` — created; the boss is still appending/editing content.
 *   - `complete`   — the authoring turn finished; content is final.
 *   - `error`      — authoring failed; partial content may be present.
 */
export const artifactStatusValues = ["generating", "complete", "error"] as const;
export type ArtifactStatus = (typeof artifactStatusValues)[number];
export const artifactStatusSchema = z.enum(artifactStatusValues);

/**
 * Hard ceiling on a `document`'s STORED markdown body (ADR-0075/0085). A long
 * document accrues here across many capped authoring calls; this is the total,
 * not the per-call budget. Single source for the schema bound and the write
 * path's by-hand guard (`.$type<>()` is compile-time only, so `write.ts` cannot
 * lean on Zod to enforce it — see {@link ARTIFACT_SECTION_MAX_CHARS}).
 */
export const DOCUMENT_MARKDOWN_MAX = 500_000;

/**
 * Per-call markdown budget for authoring a `document` (ADR-0085). Bounds one
 * `create_artifact` / `append_artifact_section` INPUT (~2,200 words ≈ ~75s of
 * generation ≈ under half the 180s stream ceiling) so a long document is
 * authored as many capped sections that accrue into one body. The STORED total
 * stays {@link DOCUMENT_MARKDOWN_MAX} (500K). The tool description, not this
 * cap, is the load-bearing forcing function: a document big enough to actually
 * time out aborts mid-argument-generation before any complete call is
 * validated, so the cap only hard-bounds a single stored write and chunks the
 * non-compliant sub-timeout case.
 *
 * Set to 15K after the live re-probe (2026-07-14, Auto/Sonnet, ~9K-word doc
 * authored as create + 8 appends, every generation ≤73s, zero stream timeouts).
 * The initial 12K under-fit its own "~1,800 words" guidance — 1,800 words of
 * markdown prose is ~11–13K chars — so the model tripped `too_big` on ~20% of
 * calls (self-correcting reissues, but wasted generations). 15K gives the
 * ~1,800-word target real headroom while staying well under the ceiling.
 */
export const ARTIFACT_SECTION_MAX_CHARS = 15_000;

/** One page of a `kind: "pages"` artifact: a title + body-level HTML. */
export const artifactPageSchema = z.object({
  /** Short page title, shown on the thumbnail and the page chrome. */
  title: z.string().max(200),
  /**
   * Body-level HTML for the page. The web renderer wraps this in the Alfred
   * artifact shell before passing it to a sandboxed `<iframe srcDoc>` (see
   * `ArtifactPageFrame`), so the stored value should not include document,
   * head, body, script, external link/CDN, page geometry, or font boilerplate.
   */
  html: z.string().max(200_000),
});
export type ArtifactPage = z.infer<typeof artifactPageSchema>;

/**
 * The artifact body, discriminated by `kind`. `document` carries markdown;
 * `pages` carries the ordered page list. (A `spreadsheet` variant will be added
 * here when that kind ships — it is intentionally absent so v1 can't construct
 * one.) Stored as a single jsonb column rather than per-kind columns so adding a
 * kind is a union edit, not a migration.
 */
export const artifactContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), markdown: z.string().max(DOCUMENT_MARKDOWN_MAX) }),
  z.object({ kind: z.literal("pages"), pages: z.array(artifactPageSchema).max(100) }),
]);
export type ArtifactContent = z.infer<typeof artifactContentSchema>;

/** Empty content for a freshly-created artifact of the given kind. */
export function emptyArtifactContent(kind: ArtifactKind): ArtifactContent {
  if (kind === "pages") return { kind: "pages", pages: [] };
  // `document` is the v1 fallback; `spreadsheet` has no content variant yet and
  // is unreachable (no authoring tool constructs it).
  return { kind: "document", markdown: "" };
}
