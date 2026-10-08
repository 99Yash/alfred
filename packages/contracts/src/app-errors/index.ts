/**
 * The public failure catalog. Every failure that leaves its code (transcript,
 * client, `execute_error`) is minted here, so exception text never leaks (ADR-0070/0072).
 * Params are enums or numbers only, are parsed on every mint, and the message is branded.
 * Design: `docs/plans/typed-failures-v1.md`.
 */
import { z } from "zod";
import { isHttpError } from "../errors";
import { enumGuard, isRecord } from "../guards";
import {
  INTEGRATION_DISPLAY_NAMES,
  INTEGRATION_SLUGS,
  isIntegrationSlug,
  type IntegrationSlug,
} from "../integrations";

const integrationSlug = z.enum(INTEGRATION_SLUGS);

/** How a human or the model can act on a failure. Consumers switch on `kind`. */
export type Fix =
  | { kind: "connect"; integration: IntegrationSlug }
  | { kind: "reconnect"; integration: IntegrationSlug }
  | { kind: "retry"; afterSeconds?: number }
  | { kind: "correct_input" }
  | { kind: "start_new_thread" }
  | { kind: "none" };

// A record, not an array, so a missing or an extra kind fails to compile.
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

/** No `z.string()`: free text must not reach the transcript through a template. */
type ClosedParamSchema =
  | z.ZodEnum
  | z.ZodNumber
  | z.ZodOptional<z.ZodEnum>
  | z.ZodOptional<z.ZodNumber>;

type ClosedParamsSchema = z.ZodObject<Record<string, ClosedParamSchema>>;

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

/** Built only by `withParams`, so one schema both validates and types the params. */
interface ParamEntry<S extends ClosedParamsSchema = ClosedParamsSchema> {
  readonly params: S;
  readonly why: string;
  /** `undefined` when `params` fail the schema. */
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

/** Drop absent optional params so the result is clean JSON. */
function definedParams(parsed: z.output<ClosedParamsSchema>) {
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
}

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
  upstream_rejected_input: withParams(
    z.object({ integration: integrationSlug.optional(), status: z.number() }),
    {
      message: ({ integration, status }) =>
        `${integration ? label(integration) : "The provider"} rejected these arguments (HTTP ${status}). ` +
        "The same call will fail again — change the arguments before you repeat it.",
      why: "An upstream 400/413/422 names the request body, not the connection, as the problem.",
      fix: (): Fix => ({ kind: "correct_input" }),
    },
  ),
});

export type AppErrorCode = keyof typeof APP_ERROR_REGISTRY;

/** The params an entry takes, or `never` for a static entry. */
export type AppErrorParams<C extends AppErrorCode> = (typeof APP_ERROR_REGISTRY)[C] extends {
  params: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

/** Codes with no params. Only these can be a fallback. */
export type StaticAppErrorCode = {
  [C in AppErrorCode]: [AppErrorParams<C>] extends [never] ? C : never;
}[AppErrorCode];

/** `[params, options?]` for a parametrized code, `[options?]` for a static one. */
type AppErrorArgs<C extends AppErrorCode> = [AppErrorParams<C>] extends [never]
  ? [options?: ErrorOptions]
  : [params: AppErrorParams<C>, options?: ErrorOptions];

declare const publicMessageBrand: unique symbol;

/** Branded so a raw `err.message` cannot pass as a public message. */
export type PublicAppErrorMessage = string & { readonly [publicMessageBrand]: true };

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

/** Call only from `renderEntry`, which reads the string from the catalog. */
function brand(message: string): PublicAppErrorMessage {
  // SAFETY: the only caller passes catalog text.
  return message as PublicAppErrorMessage;
}

/** `undefined` when a parametrized entry rejects `params`. A static entry ignores them. */
function renderEntry(code: AppErrorCode, params: unknown): PublicAppError | undefined {
  const entry: CatalogEntry = APP_ERROR_REGISTRY[code];

  if (!isParamEntry(entry)) return { code, message: brand(entry.message), fix: entry.fix };
  const rendered = entry.render(params);

  if (!rendered) return undefined;

  return { code, params: rendered.params, message: brand(rendered.message), fix: rendered.fix };
}

/** Bad params throw. The error names only the code, because the params may leak data. */
function mint(code: AppErrorCode, params: unknown): PublicAppError {
  const rendered = renderEntry(code, params);

  if (rendered) return rendered;
  throw new TypeError(`AppError "${code}" was minted with params that fail its schema`);
}

/** Mint a public error when nothing was thrown. */
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
    // A widened `AppErrorCode` breaks `AppErrorArgs`, so the entry shape picks the params slot.
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
 * An `AppError` keeps its shape. Anything else becomes `fallback`, except a
 * per-input `HttpError` (400/413/422): `retry` would make the model resend a call
 * that cannot pass, so it gets `correct_input`.
 */
export function toPublicAppError(
  err: unknown,
  fallback: PublicAppError = publicAppError(FALLBACK_APP_ERROR_CODE),
): PublicAppError {
  if (err instanceof AppError) return err.public;

  if (isHttpError(err) && err.perInputPermanent) {
    return publicAppError("upstream_rejected_input", {
      // A provider that is not a slug, such as an embedding vendor, gets generic wording.
      ...(isIntegrationSlug(err.provider) ? { integration: err.provider } : {}),
      status: err.status,
    });
  }

  return fallback;
}

/** Re-mint a stored `execute_error`. Bad or old rows become the fallback; stored text is never trusted. */
export function publicAppErrorFromStored(stored: unknown): PublicAppError {
  const fallback = publicAppError(FALLBACK_APP_ERROR_CODE);

  if (!isRecord(stored) || !isAppErrorCode(stored.code)) return fallback;

  return renderEntry(stored.code, stored.params) ?? fallback;
}
