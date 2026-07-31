import {
  boundPassthroughBody,
  canonicalJson,
  isRecord,
  jsonObjectSchema,
  mcpContentKindValues,
  type BoundedPassthroughBody,
  type McpContentKind,
  type McpResultProvenance,
} from "@alfred/contracts";
import type { JsonSchemaType, JsonSchemaValidator, Tool } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { McpClientError } from "./errors";
import { sha256Canonical } from "./hash";
import {
  isMcpSessionExpiredError,
  SdkMcpProtocolClient,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
  type McpProtocolServer,
  type SdkMcpProtocolClientOptions,
} from "./protocol";

export interface ExternalToolRef {
  kind: "mcp";
  connectionId: string;
  remoteName: string;
  catalogRevision: string;
}

export interface McpCatalogSnapshot {
  connectionId: string;
  revision: string;
  tools: readonly Tool[];
}

export interface McpCallEnvelope {
  connectionId: string;
  toolName: string;
  catalogRevision: string;
  outcome: "completed" | "tool_error";
  result: unknown;
  truncation?: BoundedPassthroughBody["truncation"];
  /**
   * Durable, payload-free record of what the server actually returned, computed
   * here where the raw result is still in hand. The broker persists it to the
   * invocation ledger so an effectful attempt stays reconstructable without
   * keeping the (sanitized, model-facing) `result` as the only durable copy.
   */
  provenance: McpResultProvenance;
}

export interface McpEndpointAuthorization {
  /**
   * Resolve a configured URL to the exact canonical endpoint Alfred may use.
   * The owner must enforce HTTPS, redirects, DNS/IP policy, and origin pinning.
   */
  authorize(endpoint: URL): Promise<URL>;
}

/**
 * What a remote server is allowed to cost Alfred: how long one request may take
 * and how large a catalog it may present. Named as a group because it is ONE
 * concern — defending against a slow or hostile server — and because naming it
 * lets the class hold the resolved bounds apart from its wiring instead of
 * restating these three keys in a type expression at the field.
 *
 * Every field defaults (`DEFAULT_*` below). The non-tunable structural caps
 * (`MAX_CATALOG_BYTES`, schema depth/nodes) are deliberately NOT here: they are
 * invariants of the trust boundary, not per-connection settings.
 */
export interface McpClientLimits {
  requestTimeoutMs?: number;
  maxCatalogPages?: number;
  maxCatalogTools?: number;
}

export interface McpRawClientOptions extends McpClientLimits {
  connectionId: string;
  endpoint: URL;
  endpointAuthorization: McpEndpointAuthorization;
  authProvider?: SdkMcpProtocolClientOptions["authProvider"];
  fetch?: SdkMcpProtocolClientOptions["fetch"];
  protocolFactory?: (endpoint: URL) => McpProtocolClient;
}

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2026-07-28"] as const;
const MCP_SUPPORTED_PROTOCOL_VERSION_SET: ReadonlySet<string> = new Set(
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CATALOG_PAGES = 100;
const DEFAULT_MAX_CATALOG_TOOLS = 1_000;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_TOOL_DESCRIPTOR_BYTES = 128 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 5_000;
const MAX_SCHEMA_REGEX_CHARS = 2_048;
const encoder = new TextEncoder();

/**
 * Model-agnostic MCP client: lifecycle, revisioned catalog, exact-schema input
 * validation, and bounded results. It deliberately knows nothing about model
 * tools, Alfred's closed builtin registry, approvals, or durable retries.
 */
export class McpRawClient {
  /** Identity + injected collaborators. The tunable bounds live on `#limits`. */
  readonly #options: Omit<McpRawClientOptions, keyof McpClientLimits>;
  /** The same bounds with every default already applied — no `??` at the use site. */
  readonly #limits: Required<McpClientLimits>;
  readonly #schemaValidator = new AjvJsonSchemaValidator();
  #protocol: McpProtocolClient | null = null;
  #negotiatedServer: McpNegotiatedServer | null = null;
  #catalog: McpCatalogSnapshot | null = null;
  #catalogGeneration = 0;
  #catalogInvalidatedHandler: (() => void) | null = null;
  #toolsByName = new Map<string, Tool>();
  #inputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
  #outputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();

  constructor(options: McpRawClientOptions) {
    // The destructure IS the split: bounds get their defaults, everything else is
    // wiring. `endpoint` is re-copied so a caller mutating theirs cannot move ours.
    const { requestTimeoutMs, maxCatalogPages, maxCatalogTools, ...wiring } = options;
    this.#options = { ...wiring, endpoint: new URL(options.endpoint.href) };
    this.#limits = {
      requestTimeoutMs: requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxCatalogPages: maxCatalogPages ?? DEFAULT_MAX_CATALOG_PAGES,
      maxCatalogTools: maxCatalogTools ?? DEFAULT_MAX_CATALOG_TOOLS,
    };
  }

  get catalog(): McpCatalogSnapshot | null {
    return this.#catalog;
  }

  get negotiatedServer(): McpNegotiatedServer | null {
    return this.#negotiatedServer;
  }

  onCatalogInvalidated(handler: () => void): void {
    this.#catalogInvalidatedHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.#protocol) return;
    const endpoint = await this.#options.endpointAuthorization.authorize(
      new URL(this.#options.endpoint.href),
    );
    const protocol = this.#options.protocolFactory
      ? this.#options.protocolFactory(endpoint)
      : new SdkMcpProtocolClient({
          endpoint,
          requestTimeoutMs: this.#limits.requestTimeoutMs,
          ...(this.#options.authProvider ? { authProvider: this.#options.authProvider } : {}),
          ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        });
    protocol.onToolsChanged(() => {
      this.#invalidateCatalog();
      this.#catalogInvalidatedHandler?.();
    });
    try {
      const negotiated = parseNegotiatedServer(await protocol.connect());
      if (!negotiated.hasTools) {
        throw new McpClientError(
          "missing_tools_capability",
          "The MCP server did not advertise the tools capability",
        );
      }
      this.#negotiatedServer = negotiated;
    } catch (err) {
      await protocol.close(false).catch(() => undefined);
      throw err;
    }
    this.#protocol = protocol;
  }

  async close(options: { terminateSession?: boolean } = {}): Promise<void> {
    const protocol = this.#protocol;
    this.#protocol = null;
    this.#negotiatedServer = null;
    this.#invalidateCatalog();
    if (protocol) await protocol.close(options.terminateSession === true);
  }

  async refreshCatalog(signal?: AbortSignal): Promise<McpCatalogSnapshot> {
    const protocol = this.#requireProtocol();
    const refreshGeneration = this.#catalogGeneration;
    const tools: Tool[] = [];
    const names = new Set<string>();
    const seenCursors = new Set<string>();
    let catalogBytes = 0;
    let cursor: string | undefined;

    for (let pageNumber = 1; ; pageNumber++) {
      if (pageNumber > this.#limits.maxCatalogPages) {
        throw new McpClientError(
          "catalog_limit",
          `MCP catalog exceeded ${this.#limits.maxCatalogPages} pages`,
        );
      }
      const page: McpProtocolPage = await protocol
        .listTools(cursor, signal)
        .catch((err: unknown) => this.#throwProtocolError(err, protocol));
      for (const tool of page.tools) {
        assertAdmissibleToolDescriptor(tool);
        const descriptorBytes = encodedBytes(canonicalJson(tool));
        if (descriptorBytes > MAX_TOOL_DESCRIPTOR_BYTES) {
          throw new McpClientError(
            "catalog_limit",
            `MCP tool '${tool.name}' descriptor exceeded ${MAX_TOOL_DESCRIPTOR_BYTES} bytes`,
          );
        }
        catalogBytes += descriptorBytes;
        if (catalogBytes > MAX_CATALOG_BYTES) {
          throw new McpClientError(
            "catalog_limit",
            `MCP catalog exceeded ${MAX_CATALOG_BYTES} descriptor bytes`,
          );
        }
        if (names.has(tool.name)) {
          throw new McpClientError("duplicate_tool", `MCP catalog repeated tool '${tool.name}'`);
        }
        names.add(tool.name);
        tools.push(tool);
        if (tools.length > this.#limits.maxCatalogTools) {
          throw new McpClientError(
            "catalog_limit",
            `MCP catalog exceeded ${this.#limits.maxCatalogTools} tools`,
          );
        }
      }

      const nextCursor = page.nextCursor;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        throw new McpClientError("catalog_limit", "MCP catalog repeated a pagination cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const sortedTools = Object.freeze(
      tools
        .map((tool) => deepFreeze(structuredClone(tool)))
        // Deterministic code-point order, not `localeCompare`: the revision hash
        // is a durable authority key compared across hosts/processes, and ICU
        // collation is locale/build-dependent (small-icu vs full-icu, LANG), so
        // the same tool set could otherwise hash differently per environment.
        // Names are already de-duplicated, so this total order over distinct
        // strings is all that's needed.
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
    const revision = sha256Canonical(sortedTools);
    const nextToolsByName = new Map(sortedTools.map((tool) => [tool.name, tool]));
    const nextInputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
    const nextOutputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
    for (const tool of sortedTools) {
      let validator: JsonSchemaValidator<Record<string, unknown>>;
      try {
        validator = this.#schemaValidator.getValidator<Record<string, unknown>>(
          tool.inputSchema as JsonSchemaType,
        );
      } catch (err) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${tool.name}' has an input schema Alfred cannot compile: ${errorMessage(err)}`,
        );
      }
      nextInputValidators.set(tool.name, validator);
      if (tool.outputSchema) {
        try {
          nextOutputValidators.set(
            tool.name,
            this.#schemaValidator.getValidator<Record<string, unknown>>(
              tool.outputSchema as JsonSchemaType,
            ),
          );
        } catch (err) {
          throw new McpClientError(
            "invalid_schema",
            `MCP tool '${tool.name}' has an output schema Alfred cannot compile: ${errorMessage(err)}`,
          );
        }
      }
    }
    if (refreshGeneration !== this.#catalogGeneration) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP catalog changed while Alfred was refreshing it; retry the refresh",
      );
    }
    this.#toolsByName = nextToolsByName;
    this.#inputValidators = nextInputValidators;
    this.#outputValidators = nextOutputValidators;
    this.#catalog = Object.freeze({
      connectionId: this.#options.connectionId,
      revision,
      tools: sortedTools,
    });
    return this.#catalog;
  }

  async callTool(
    ref: ExternalToolRef,
    args: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpCallEnvelope> {
    const protocol = this.#requireProtocol();
    const catalog = this.#catalog;
    if (!catalog) {
      throw new McpClientError(
        "catalog_required",
        "The MCP catalog must be refreshed before a tool can be called",
      );
    }
    if (ref.connectionId !== this.#options.connectionId) {
      throw new McpClientError("unknown_tool", "The MCP tool belongs to another connection");
    }
    if (ref.catalogRevision !== catalog.revision) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP catalog changed after this tool was selected; refresh and reselect it",
      );
    }

    const tool = this.#toolsByName.get(ref.remoteName);
    const validator = this.#inputValidators.get(ref.remoteName);
    if (!tool || !validator) {
      throw new McpClientError("unknown_tool", `Unknown MCP tool '${ref.remoteName}'`);
    }
    if (tool.execution?.taskSupport === "required") {
      throw new McpClientError(
        "unsupported_task_tool",
        `MCP tool '${tool.name}' requires experimental Tasks, which Alfred does not enable`,
      );
    }

    const jsonArgs = jsonObjectSchema.safeParse(args);
    if (!jsonArgs.success) {
      throw new McpClientError(
        "invalid_arguments",
        `Arguments for MCP tool '${tool.name}' must be a JSON object`,
      );
    }
    const validated = validator(jsonArgs.data);
    if (!validated.valid) {
      throw new McpClientError(
        "invalid_arguments",
        `Arguments for MCP tool '${tool.name}' failed its imported schema: ${validated.errorMessage}`,
      );
    }

    const result: McpProtocolCallResult = await protocol
      .callTool(tool, validated.data, options.signal)
      .catch((err: unknown) => this.#throwProtocolError(err, protocol));
    const isToolError = isRecord(result) && result.isError === true;
    const outputValidator = this.#outputValidators.get(tool.name);
    let outputSchemaValidated = false;
    if (!isToolError && outputValidator) {
      const structuredContent = isRecord(result) ? result.structuredContent : undefined;
      const output = outputValidator(structuredContent);
      if (!output.valid) {
        // A response DID cross the wire — the census is derivable now. Carry it
        // on the error so the broker's ambiguous branch persists provenance
        // (#541) rather than leaving only an error string; the effect stays
        // unprovable, but `outputSchemaValidated: false` records exactly why.
        throw new McpClientError(
          "invalid_output",
          `Result from MCP tool '${tool.name}' failed its declared output schema: ${output.errorMessage}`,
          {
            provenance: resultProvenance(result, {
              isToolError,
              outputSchemaValidated: false,
              truncated: false,
            }),
          },
        );
      }
      outputSchemaValidated = true;
    }
    const bounded = boundPassthroughBody(result);
    return {
      connectionId: this.#options.connectionId,
      toolName: tool.name,
      catalogRevision: catalog.revision,
      outcome: isToolError ? "tool_error" : "completed",
      result: bounded.value,
      provenance: resultProvenance(result, {
        isToolError,
        outputSchemaValidated,
        truncated: Boolean(bounded.truncation),
      }),
      ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
    };
  }

  #requireProtocol(): McpProtocolClient {
    if (!this.#protocol) {
      throw new McpClientError("not_connected", "The MCP client is not connected");
    }
    return this.#protocol;
  }

  #invalidateCatalog(): void {
    this.#catalogGeneration += 1;
    this.#catalog = null;
    this.#toolsByName.clear();
    this.#inputValidators.clear();
    this.#outputValidators.clear();
  }

  async #throwProtocolError(err: unknown, protocol: McpProtocolClient): Promise<never> {
    if (this.#negotiatedServer?.protocolEra !== "legacy" || !isMcpSessionExpiredError(err)) {
      throw err;
    }
    if (this.#protocol === protocol) {
      this.#protocol = null;
      this.#negotiatedServer = null;
      this.#invalidateCatalog();
    }
    await protocol.close(false).catch(() => undefined);
    throw new McpClientError(
      "session_expired",
      "The MCP session expired; reconnect and refresh the catalog before retrying",
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown schema error";
}

const MCP_CONTENT_KINDS: ReadonlySet<string> = new Set(mcpContentKindValues);

/**
 * Map a content block to its closed census kind. The SDK validates blocks
 * against the `ContentBlock` union before they reach here, so a valid result
 * only ever yields a declared kind; `unknown` is the documented fallback for an
 * untyped or degraded shape, never an open passthrough of the server's string.
 */
function contentKindOf(block: unknown): McpContentKind {
  const type = isRecord(block) && typeof block.type === "string" ? block.type : "unknown";
  return MCP_CONTENT_KINDS.has(type) ? (type as McpContentKind) : "unknown";
}

/**
 * Distill the raw protocol result into the durable, payload-free provenance
 * envelope (#541). Census the content blocks by `type` and record the validity
 * facts already established above — never the block content, and a returned
 * resource link is counted, never dereferenced.
 */
function resultProvenance(
  result: McpProtocolCallResult,
  facts: { isToolError: boolean; outputSchemaValidated: boolean; truncated: boolean },
): McpResultProvenance {
  const record = isRecord(result) ? result : undefined;
  const content = record && Array.isArray(record.content) ? record.content : [];
  const contentKinds: Partial<Record<McpContentKind, number>> = {};
  for (const block of content) {
    const kind = contentKindOf(block);
    contentKinds[kind] = (contentKinds[kind] ?? 0) + 1;
  }
  return {
    isError: facts.isToolError,
    hasStructuredContent: record ? record.structuredContent !== undefined : false,
    outputSchemaValidated: facts.outputSchemaValidated,
    contentBlockCount: content.length,
    contentKinds,
    truncated: facts.truncated,
  };
}

function encodedBytes(value: string): number {
  return encoder.encode(value).length;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  if (typeof value === "object" && value !== null) Object.freeze(value);
  return value;
}

function assertAdmissibleToolDescriptor(tool: Tool): void {
  if (tool.name.length === 0 || tool.name.length > 128 || hasAsciiControlCharacter(tool.name)) {
    throw new McpClientError(
      "invalid_schema",
      "MCP tool name must be 1-128 characters with no control characters",
    );
  }
  assertSafeSchema(tool.name, "input", tool.inputSchema);
  if (tool.outputSchema) assertSafeSchema(tool.name, "output", tool.outputSchema);
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertSafeSchema(toolName: string, direction: "input" | "output", schema: unknown): void {
  let nodes = 0;

  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (depth > MAX_SCHEMA_DEPTH || nodes > MAX_SCHEMA_NODES) {
      throw new McpClientError(
        "invalid_schema",
        `MCP tool '${toolName}' ${direction} schema exceeds Alfred's complexity limits`,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      // Reject schema identity anchors outright. Alfred forbids external refs
      // and only ever compiles inline schemas, so `$id`/`$anchor` carry no
      // legitimate function here — but the shared Ajv instance caches compiled
      // validators by `$id`, so a malicious server could register a permissive
      // schema under `$id: "x"` and then have a second tool (or a later schema
      // revision) reuse `$id: "x"` to be validated against the *cached* lenient
      // validator instead of its own descriptor. That silently bypasses the
      // exact-schema gate this layer exists to enforce, so we refuse the anchor.
      if (key === "$id" || key === "$anchor") {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema declares a forbidden ${key}`,
        );
      }
      if (key === "x-mcp-header") {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema declares forbidden x-mcp-header`,
        );
      }
      if (
        (key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") &&
        (typeof child !== "string" || !child.startsWith("#"))
      ) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema contains a non-local ${key}`,
        );
      }
      if (key === "pattern" && typeof child === "string" && child.length > MAX_SCHEMA_REGEX_CHARS) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema contains an oversized regex`,
        );
      }
      if (key === "patternProperties" && isRecord(child)) {
        for (const pattern of Object.keys(child)) {
          if (pattern.length > MAX_SCHEMA_REGEX_CHARS) {
            throw new McpClientError(
              "invalid_schema",
              `MCP tool '${toolName}' ${direction} schema contains an oversized regex`,
            );
          }
        }
      }
      visit(child, depth + 1);
    }
  };

  visit(schema, 0);
}

function parseNegotiatedServer(server: McpProtocolServer): McpNegotiatedServer {
  const facts = {
    serverName: server.serverName,
    serverVersion: server.serverVersion,
    hasTools: server.hasTools,
    toolsListChanged: server.toolsListChanged,
  };
  if (server.protocolEra === "legacy" && server.protocolVersion === "2025-11-25") {
    return { ...facts, protocolEra: "legacy", protocolVersion: "2025-11-25" };
  }
  if (server.protocolEra === "modern" && server.protocolVersion === "2026-07-28") {
    return { ...facts, protocolEra: "modern", protocolVersion: "2026-07-28" };
  }
  const version = server.protocolVersion || "unknown";
  if (!MCP_SUPPORTED_PROTOCOL_VERSION_SET.has(version)) {
    throw new McpClientError(
      "unsupported_protocol_version",
      `Alfred MCP supports protocols ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(" and ")}; server negotiated ${version}`,
    );
  }
  throw new McpClientError(
    "unsupported_protocol_version",
    `MCP protocol era '${server.protocolEra}' does not match negotiated version ${version}`,
  );
}
