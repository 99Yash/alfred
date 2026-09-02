/**
 * The public failure catalog.
 *
 * Every failure that crosses a boundary (the model transcript, the client, the
 * `execute_error` column) is minted here and nowhere else. A public failure
 * carries three things: a `code` from this closed catalog, a `message` that the
 * code decides, and a `fix` a machine can read. Arbitrary exception text never
 * crosses a boundary (ADR-0070 §1.3), and a consumer never sniffs the message
 * to decide what to do (ADR-0072) — it switches on `fix.kind`.
 *
 * Two rules keep a parametrized message as safe as the old literal one:
 *
 *   - `params` are closed enums or numbers, never free strings. The
 *     {@link ClosedParamSchema} constraint rejects a `z.string()` param at the
 *     type level, so a provider's scope list or an exception message cannot
 *     re-enter the transcript through a template.
 *   - `message` is branded. Only {@link publicAppError} can mint one, so a
 *     `{ code, message: err.message }` literal does not type-check at the
 *     persistence door.
 *
 * Design: `docs/plans/typed-failures-v1.md`.
 */
import { z } from "zod";
import { enumGuard, isRecord } from "../guards";
import { INTEGRATION_DISPLAY_NAMES, INTEGRATION_SLUGS, type IntegrationSlug } from "../tools";

/**
 * How a human or the model can act on a failure. Closed: every consumer
 * switches on `kind` with a `never` guard, so a new remediation kind fails each
 * consumer until it handles it. The web retry button and the connect nudge are
 * projections of this value, not sources of their own.
 */
export type Fix =
  | { kind: "connect"; integration: IntegrationSlug }
  | { kind: "reconnect"; integration: IntegrationSlug }
  | { kind: "retry"; afterSeconds?: number }
  | { kind: "correct_input" }
  | { kind: "start_new_thread" }
  | { kind: "none" };

export const FIX_KINDS = [
  "connect",
  "reconnect",
  "retry",
  "correct_input",
  "start_new_thread",
  "none",
] as const satisfies readonly Fix["kind"][];

/**
 * The only zod shapes a catalog param may take. A bare `z.string()` is not in
 * this union on purpose — see the module header.
 */
type ClosedParamSchema =
  | z.ZodEnum
  | z.ZodNumber
  | z.ZodOptional<z.ZodEnum>
  | z.ZodOptional<z.ZodNumber>;
type ClosedParamsSchema = z.ZodObject<Record<string, ClosedParamSchema>>;

interface StaticEntry {
  readonly message: string;
  /** The cause a developer reads; never shown to the user or the model. */
  readonly why: string;
  readonly fix: Fix;
}
interface ParamEntry {
  readonly params: ClosedParamsSchema;
  // `never` here is contravariance, not a lie: a `(p: IntegrationParams) =>
  // string` is assignable to `(p: never) => string`, so an entry may annotate
  // its own params type and the catalog still accepts it.
  readonly message: (params: never) => string;
  readonly why: string;
  readonly fix: (params: never) => Fix;
}
type CatalogEntry = StaticEntry | ParamEntry;

/** Identity with a constraint: the value is the catalog, the type is the check. */
function defineFailureCatalog<const C extends Record<string, CatalogEntry>>(catalog: C): C {
  return catalog;
}

const integrationParams = z.object({ integration: z.enum(INTEGRATION_SLUGS) });
type IntegrationParams = z.infer<typeof integrationParams>;

function label(integration: IntegrationSlug): string {
  return INTEGRATION_DISPLAY_NAMES[integration];
}

export const APP_ERROR_REGISTRY = defineFailureCatalog({
  artifact_create_failed: {
    message: "Saving the artifact failed; nothing was created.",
    why: "The artifact insert or its file write threw before commit.",
    fix: { kind: "retry" },
  },
  calendar_bounds_order: {
    message: "Calendar requires timeMax to be after timeMin.",
    why: "The caller supplied a time window whose end precedes its start.",
    fix: { kind: "correct_input" },
  },
  connection_required: {
    params: integrationParams,
    message: ({ integration }: IntegrationParams) => `${label(integration)} is not connected.`,
    why: "No usable credential exists for this integration.",
    fix: ({ integration }: IntegrationParams) => ({ kind: "connect", integration }),
  },
  reauth_required: {
    params: integrationParams,
    message: ({ integration }: IntegrationParams) =>
      `${label(integration)} needs to be reconnected.`,
    why: "A credential exists but is revoked, expired, or incomplete, and cannot act.",
    fix: ({ integration }: IntegrationParams) => ({ kind: "reconnect", integration }),
  },
  account_read_failed: {
    params: integrationParams,
    message: ({ integration }: IntegrationParams) =>
      `A connected ${label(integration)} account could not be read.`,
    why: "One credential's provider call failed while a sibling credential may still answer.",
    fix: ({ integration }: IntegrationParams) => ({ kind: "reconnect", integration }),
  },
  integration_unavailable: {
    params: integrationParams,
    message: ({ integration }: IntegrationParams) =>
      `${label(integration)} could not be read from any connected account.`,
    why: "Every connected credential for this integration failed the same read.",
    fix: ({ integration }: IntegrationParams) => ({ kind: "reconnect", integration }),
  },
  railway_credential_required: {
    message: "Choose an active Railway credential from list_projects and try again.",
    why: "The tool needs one credential and the caller named none or an unknown one.",
    fix: { kind: "correct_input" },
  },
  run_cancelled: {
    message: "The run was cancelled; this action did not run.",
    why: "A cancellation fence advanced between dispatch and execution.",
    fix: { kind: "none" },
  },
  tool_input_invalid: {
    message: "The tool input is invalid. Correct it and try again.",
    why: "The input failed the tool's schema after normalization.",
    fix: { kind: "correct_input" },
  },
  tool_execution_failed: {
    message: "The tool failed unexpectedly. Please try again.",
    why: "The tool threw something the dispatcher could not classify.",
    fix: { kind: "retry" },
  },
});

export type AppErrorCode = keyof typeof APP_ERROR_REGISTRY;

/** The params an entry takes, or `never` for a static entry. */
export type AppErrorParams<C extends AppErrorCode> = (typeof APP_ERROR_REGISTRY)[C] extends {
  params: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

/** The codes that take no params — the only legal fallback codes. */
export type StaticAppErrorCode = {
  [C in AppErrorCode]: [AppErrorParams<C>] extends [never] ? C : never;
}[AppErrorCode];

/** `[params, options?]` for a parametrized code, `[options?]` for a static one. */
type AppErrorArgs<C extends AppErrorCode> = [AppErrorParams<C>] extends [never]
  ? [options?: ErrorOptions]
  : [params: AppErrorParams<C>, options?: ErrorOptions];

declare const publicMessageBrand: unique symbol;
/** A message rendered by the catalog. The brand is what keeps `err.message` out. */
export type PublicAppErrorMessage = string & { readonly [publicMessageBrand]: true };

/** The one shape a failure has once it leaves the code that raised it. */
export type PublicAppError = {
  readonly code: AppErrorCode;
  readonly params?: Record<string, string | number>;
  readonly message: PublicAppErrorMessage;
  readonly fix: Fix;
};

export const FALLBACK_APP_ERROR_CODE = "tool_execution_failed" satisfies StaticAppErrorCode;

export const APP_ERROR_CODES: readonly AppErrorCode[] =
  // SAFETY: `Object.keys` of the catalog literal enumerates exactly `AppErrorCode`.
  Object.keys(APP_ERROR_REGISTRY) as AppErrorCode[];
export const isAppErrorCode = enumGuard(APP_ERROR_CODES);

function isParamEntry(entry: CatalogEntry): entry is ParamEntry {
  return "params" in entry;
}

type RenderedParams = Record<string, string | number>;

/**
 * The only place a string becomes a public message. Every caller is `render`,
 * which reads the string from the catalog itself.
 */
function brand(message: string): PublicAppErrorMessage {
  // SAFETY: the brand certifies "rendered by the catalog"; see the doc comment.
  return message as PublicAppErrorMessage;
}

/**
 * Render one entry. Every `PublicAppError` in the system comes through here,
 * which is what makes the message brand truthful. `params` must already be
 * validated by the entry's schema (the typed constructors guarantee it at the
 * type level; {@link publicAppErrorFromStored} does it at runtime).
 */
function render(code: AppErrorCode, params: RenderedParams | undefined): PublicAppError {
  const entry: CatalogEntry = APP_ERROR_REGISTRY[code];
  if (!isParamEntry(entry)) return { code, message: brand(entry.message), fix: entry.fix };
  // SAFETY: `params` was produced by `entry.params` (typed constructor or
  // `safeParse`), which is exactly the type the entry's callbacks declare.
  const typed = params as never;
  return {
    code,
    params: params ?? {},
    message: brand(entry.message(typed)),
    fix: entry.fix(typed),
  };
}

/**
 * Widen a typed params value for `render`. Any `AppErrorParams<C>` is the output
 * of a `ClosedParamsSchema`, so its values are enum members or numbers.
 */
function toRenderedParams(params: unknown): RenderedParams | undefined {
  // SAFETY: see the doc comment; the constraint on `ClosedParamSchema` is what
  // makes every value a string or a number.
  return params === undefined ? undefined : (params as RenderedParams);
}

/** A public error minted directly from a code — the "there was no thrown error" form. */
export function publicAppError<C extends AppErrorCode>(
  code: C,
  ...rest: [AppErrorParams<C>] extends [never] ? [] : [params: AppErrorParams<C>]
): PublicAppError {
  return render(code, toRenderedParams(rest[0]));
}

export class AppError<C extends AppErrorCode = AppErrorCode> extends Error {
  readonly _tag = "AppError" as const;
  readonly code: C;
  readonly public: PublicAppError;

  constructor(code: C, ...rest: AppErrorArgs<C>) {
    const entry: CatalogEntry = APP_ERROR_REGISTRY[code];
    // `AppErrorArgs` puts params first only when the entry declares them, so the
    // entry shape tells us which tuple arm `rest` is.
    const [params, options] = isParamEntry(entry)
      ? [toRenderedParams(rest[0]), asErrorOptions(rest[1])]
      : [undefined, asErrorOptions(rest[0])];
    const rendered = render(code, params);
    super(rendered.message, options);
    this.name = "AppError";
    this.code = code;
    this.public = rendered;
  }
}

function asErrorOptions(value: unknown): ErrorOptions | undefined {
  return isRecord(value) && "cause" in value ? { cause: value.cause } : undefined;
}

/**
 * Project a caught value through the catalog. An `AppError` keeps its own
 * public shape; anything else becomes `fallback`, so exception text never
 * reaches persistence or the model.
 */
export function toPublicAppError(
  err: unknown,
  fallback: PublicAppError = publicAppError(FALLBACK_APP_ERROR_CODE),
): PublicAppError {
  return err instanceof AppError ? err.public : fallback;
}

/**
 * Re-mint a persisted `execute_error` for replay. The stored `{ code, params }`
 * is re-validated against the entry's own schema, so a legacy row (a deleted
 * code, raw exception text) or a poisoned param (a slug that is not in the
 * enum, a NUL byte) replays as the generic fallback and never as its stored
 * text. `message` and `fix` are re-derived, not trusted from the row.
 */
export function publicAppErrorFromStored(stored: unknown): PublicAppError {
  const fallback = publicAppError(FALLBACK_APP_ERROR_CODE);
  if (!isRecord(stored) || !isAppErrorCode(stored.code)) return fallback;
  const entry: CatalogEntry = APP_ERROR_REGISTRY[stored.code];
  if (!isParamEntry(entry)) return render(stored.code, undefined);
  const parsed = entry.params.safeParse(stored.params);
  if (!parsed.success) return fallback;
  // An optional param that was absent parses to `undefined`; drop it so the
  // rendered `params` stays a JSON object with no undefined values.
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) params[key] = value;
  }
  return render(stored.code, params);
}
