import { z } from "zod";

/**
 * The contract between `import-probe.ts` (the child program) and
 * `../barrel-load.test.ts` (the driver that spawns one child per advertised subpath).
 *
 * It crosses a process boundary as one line of text, so the driver treats it as protocol
 * data: `parseImportProbeReport` is the owning boundary and every field is validated
 * there. A child that dies mid-write, or that prints a tsx diagnostic instead of a
 * report, must not be able to hand the driver a half-shaped object whose missing `arms`
 * array reads as "this barrel armed no timer".
 */
const importProbeReportSchema = z.object({
  /** Each `setInterval` / `setTimeout` armed across the `await import(...)`, in call order. */
  arms: z.array(z.string()),
  /** Per-kind increase in `Timeout` / `TCP*` / `TLS*` handles across the import. */
  handleDelta: z.record(z.string(), z.number()),
  /** The subpath's own export names, sorted. */
  names: z.array(z.string()),
  /** The import's own failure (`name: first line`), or null. */
  importError: z.string().nullable(),
});

export type ImportProbeReport = z.infer<typeof importProbeReportSchema>;

/** Keeps a failure message readable when the child printed a stack trace instead of JSON. */
const RAW_EXCERPT_LIMIT = 400;

function excerpt(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (text === undefined) return String(raw);
  return text.length > RAW_EXCERPT_LIMIT ? `${text.slice(0, RAW_EXCERPT_LIMIT)}…` : text;
}

/**
 * Validates one line of child stdout.
 *
 * `raw` is `unknown` because it is whatever the spawn produced — the child may have
 * written nothing at all. Throws carrying the raw text, and never returns a partial
 * report: an unreadable child is a test failure, not an absence of findings.
 */
export function parseImportProbeReport(raw: unknown): ImportProbeReport {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`import probe child wrote no report line; got: ${excerpt(raw)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`import probe child wrote unparseable stdout (${reason}): ${excerpt(raw)}`);
  }

  const result = importProbeReportSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `import probe child wrote a report of the wrong shape (${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}): ${excerpt(raw)}`,
    );
  }
  return result.data;
}
