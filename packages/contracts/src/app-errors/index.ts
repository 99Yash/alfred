/**
 * The public failure catalog.
 *
 * Every failure that crosses a boundary (the model transcript, the client, the
 * `execute_error` column) is minted here and nowhere else. A public failure
 * carries three things: a `code` from this closed catalog, a `message` that the
 * code decides, and a `fix` a machine can read. Arbitrary exception text never
 * crosses a boundary (the catalog is the transcript-side twin of the ADR-0070
 * persistence rail), and a consumer never sniffs the message to decide what to
 * do (ADR-0072) — it switches on `fix.kind`.
 *
 * Three rules keep a parametrized message as safe as the old literal one:
 *
 *   - `params` are closed enums or numbers, never free strings. The
 *     {@link ClosedParamSchema} constraint rejects a `z.string()` param at the
 *     type level, so a provider's scope list or an exception message cannot
 *     re-enter the transcript through a template.
 *   - `params` are parsed by the entry's own schema every time a failure is
 *     minted, not only on replay. A widened `AppErrorCode` lets a caller reach
 *     a parametrized entry with no params (or with an `ErrorOptions` object in
 *     the params slot); the parse turns that into a loud `TypeError` instead
 *     of a message that reads `undefined` and a `params` object that carries
 *     the cause.
 *   - `message` is branded. Only the catalog can mint one, so a
 *     `{ code, message: err.message }` literal does not type-check at the
 *     persistence door.
 *
 * Design: `docs/plans/typed-failures-v1.md`.
 */
import { z } from "zod";
import { enumGuard, isRecord } from "../guards";
import {
  INTEGRATION_DISPLAY_NAMES,
  INTEGRATION_SLUGS,
  type IntegrationSlug,
} from "../integrations";

const integrationSlug = z.enum(INTEGRATION_SLUGS);

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

// A `Record` over the union, not an array `satisfies` a membership check: the
// record fails to compile when a kind is missing AND when one is extra, so the
// list below cannot lag the type in either direction.
const FIX_KIND_SET = {
  connect: true,
  reconnect: true,
  retry: true,
  correct_input: true,
  start_new_thread: true,
  none: true,
} satisfies Record<Fix["kind"], true>;
export const FIX_KINDS: readonly Fix["kind"][] =
  // SAFETY: `Object.keys` of the exhaustive record enumerates exactly `Fix["kind"]`.
  Object.keys(FIX_KIND_SET) as Fix["kind"][];
export const isFixKind = enumGuard(FIX_KINDS);

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

/** What every value of a parsed `ClosedParamsSchema` is once `undefined` is dropped. */
type RenderedParams = Record<string, string | number>;

interface Rendered {
  readonly params: RenderedParams;
  readonly message: string;
  readonly fix: Fix;
}

interface StaticEntry {
  readonly message: string;
  /** The cause a developer reads; never shown to the user or the model. */
  readonly why: string;
  readonly fix: Fix;
}

/**
 * A parametrized entry. Only {@link withParams} builds one, and it closes over
 * the schema and the two callbacks together, so the schema that validates the
 * params is the same one that types them. `params` stays visible so
 * {@link AppErrorParams} can read the schema's output type off the catalog.
 */
interface ParamEntry<S extends ClosedParamsSchema = ClosedParamsSchema> {
  readonly params: S;
  readonly why: string;
  /** Validate `params` against `this.params` and render; `undefined` when they fail. */
  readonly render: (params: unknown) => Rendered | undefined;
}
type CatalogEntry = StaticEntry | ParamEntry;

function withParams<S extends ClosedParamsSchema>(
  params: S,
  entry: {
    readonly message: (params: z.output<S>) => string;
    readonly why: string;
    readonly fix: (params: z.output<S>) => Fix;
  },
): ParamEntry<S> {
  return {
    params,
    why: entry.why,
    render(raw) {
      const parsed = params.safeParse(raw);
      if (!parsed.success) return undefined;
      return {
        params: definedParams(parsed.data),
        message: entry.message(parsed.data),
        fix: entry.fix(parsed.data),
      };
    },
  };
}

/**
 * An optional param that was absent parses to `undefined`; drop it so the
 * rendered `params` stays a JSON object with no undefined values.
 */
function definedParams(parsed: z.output<ClosedParamsSchema>) {
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
}

/** Identity with a constraint: the value is the catalog, the type is the check. */
function defineFailureCatalog<const C extends Record<string, CatalogEntry>>(catalog: C): C {
  return catalog;
}

const integrationParams = z.object({ integration: integrationSlug });
type IntegrationParams = z.output<typeof integrationParams>;

function label(integration: IntegrationSlug): string {
  return INTEGRATION_DISPLAY_NAMES[integration];
}
const connect = ({ integration }: IntegrationParams): Fix => ({ kind: "connect", integration });
const reconnect = ({ integration }: IntegrationParams): Fix => ({ kind: "reconnect", integration });

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
  connection_required: withParams(integrationParams, {
    message: ({ integration }) => `${label(integration)} is not connected.`,
    why: "No usable credential exists for this integration.",
    fix: connect,
  }),
  reauth_required: withParams(integrationParams, {
    message: ({ integration }) => `${label(integration)} needs to be reconnected.`,
    why: "A credential exists but is revoked, expired, or incomplete, and cannot act.",
    fix: reconnect,
  }),
  account_read_failed: withParams(integrationParams, {
    message: ({ integration }) => `A connected ${label(integration)} account could not be read.`,
    why: "One credential's provider call failed while a sibling credential may still answer.",
    fix: reconnect,
  }),
  integration_unavailable: withParams(integrationParams, {
    message: ({ integration }) =>
      `${label(integration)} could not be read from any connected account.`,
    why: "Every connected credential for this integration failed the same read.",
    fix: reconnect,
  }),
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
  mcp_effect_not_applied: {
    message: "You confirmed that this MCP operation did not apply. It was not repeated.",
    why: "The user resolved an unresolved MCP invocation as not applied; the effect is closed.",
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
  readonly params?: RenderedParams;
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

/**
 * The only place a string becomes a public message. Every caller is
 * {@link renderEntry}, which reads the string from the catalog itself.
 */
function brand(message: string): PublicAppErrorMessage {
  // SAFETY: the brand certifies "rendered by the catalog"; see the doc comment.
  return message as PublicAppErrorMessage;
}

/**
 * Render one entry, or `undefined` when a parametrized entry rejects `params`.
 * Every `PublicAppError` in the system comes through here, which is what makes
 * the message brand truthful. A static entry ignores `params`.
 */
function renderEntry(code: AppErrorCode, params: unknown): PublicAppError | undefined {
  const entry: CatalogEntry = APP_ERROR_REGISTRY[code];
  if (!isParamEntry(entry)) return { code, message: brand(entry.message), fix: entry.fix };
  const rendered = entry.render(params);
  if (!rendered) return undefined;
  return { code, params: rendered.params, message: brand(rendered.message), fix: rendered.fix };
}

/**
 * Mint a failure from code that knows what it is throwing. Bad params are a
 * programming error here, so they throw. The `TypeError` names the code and
 * nothing else: the rejected params are the very value that must not leak.
 */
function mint(code: AppErrorCode, params: unknown): PublicAppError {
  const rendered = renderEntry(code, params);
  if (rendered) return rendered;
  throw new TypeError(`AppError "${code}" was minted with params that fail its schema`);
}

/** A public error minted directly from a code — the "there was no thrown error" form. */
export function publicAppError<C extends AppErrorCode>(
  code: C,
  ...rest: [AppErrorParams<C>] extends [never] ? [] : [params: AppErrorParams<C>]
): PublicAppError {
  return mint(code, rest[0]);
}

export class AppError<C extends AppErrorCode = AppErrorCode> extends Error {
  readonly _tag = "AppError" as const;
  readonly code: C;
  readonly public: PublicAppError;

  constructor(code: C, ...rest: AppErrorArgs<C>) {
    const entry: CatalogEntry = APP_ERROR_REGISTRY[code];
    // `AppErrorArgs` is only trustworthy for a literal code. For a widened
    // `AppErrorCode` the conditional collapses to one arm, so the entry shape,
    // not the tuple type, decides which slot holds params and which holds
    // options. `args` is `unknown[]` on purpose: `mint` parses the params slot.
    const args: readonly unknown[] = rest;
    const [params, options] = isParamEntry(entry)
      ? [args[0], asErrorOptions(args[1])]
      : [undefined, asErrorOptions(args[0])];
    const rendered = mint(code, params);
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
  return renderEntry(stored.code, stored.params) ?? fallback;
}
