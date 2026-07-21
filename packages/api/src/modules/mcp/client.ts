import { canonicalJson, isRecord, jsonObjectSchema } from "@alfred/contracts";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { boundPassthroughBody, type BoundedPassthroughBody } from "../tools/passthrough";
import { McpClientError } from "./errors";
import {
  isMcpSessionExpiredError,
  SdkMcpProtocolClient,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
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
}

export interface McpEndpointAuthorization {
  /**
   * Resolve a configured URL to the exact canonical endpoint Alfred may use.
   * The owner must enforce HTTPS, redirects, DNS/IP policy, and origin pinning.
   */
  authorize(endpoint: URL): Promise<URL>;
}

export interface McpRawClientOptions {
  connectionId: string;
  endpoint: URL;
  endpointAuthorization: McpEndpointAuthorization;
  authProvider?: SdkMcpProtocolClientOptions["authProvider"];
  fetch?: SdkMcpProtocolClientOptions["fetch"];
  requestTimeoutMs?: number;
  maxCatalogPages?: number;
  maxCatalogTools?: number;
  protocolFactory?: (endpoint: URL) => McpProtocolClient;
}

export const MCP_V1_PROTOCOL_VERSION = "2025-11-25";
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
  readonly #options: Required<
    Pick<McpRawClientOptions, "requestTimeoutMs" | "maxCatalogPages" | "maxCatalogTools">
  > &
    Omit<McpRawClientOptions, "requestTimeoutMs" | "maxCatalogPages" | "maxCatalogTools">;
  readonly #schemaValidator = new AjvJsonSchemaValidator();
  #protocol: McpProtocolClient | null = null;
  #negotiatedServer: McpNegotiatedServer | null = null;
  #catalog: McpCatalogSnapshot | null = null;
  #catalogGeneration = 0;
  #toolsByName = new Map<string, Tool>();
  #inputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
  #outputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();

  constructor(options: McpRawClientOptions) {
    this.#options = {
      ...options,
      endpoint: new URL(options.endpoint.href),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxCatalogPages: options.maxCatalogPages ?? DEFAULT_MAX_CATALOG_PAGES,
      maxCatalogTools: options.maxCatalogTools ?? DEFAULT_MAX_CATALOG_TOOLS,
    };
  }

  get catalog(): McpCatalogSnapshot | null {
    return this.#catalog;
  }

  get negotiatedServer(): McpNegotiatedServer | null {
    return this.#negotiatedServer;
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
          requestTimeoutMs: this.#options.requestTimeoutMs,
          ...(this.#options.authProvider ? { authProvider: this.#options.authProvider } : {}),
          ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        });
    protocol.onToolsChanged(() => this.#invalidateCatalog());
    try {
      const negotiated = await protocol.connect();
      if (negotiated.protocolVersion !== MCP_V1_PROTOCOL_VERSION) {
        throw new McpClientError(
          "unsupported_protocol_version",
          `Alfred MCP v1 requires protocol ${MCP_V1_PROTOCOL_VERSION}; server negotiated ${negotiated.protocolVersion || "unknown"}`,
        );
      }
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
      if (pageNumber > this.#options.maxCatalogPages) {
        throw new McpClientError(
          "catalog_limit",
          `MCP catalog exceeded ${this.#options.maxCatalogPages} pages`,
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
        if (tools.length > this.#options.maxCatalogTools) {
          throw new McpClientError(
            "catalog_limit",
            `MCP catalog exceeded ${this.#options.maxCatalogTools} tools`,
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
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    const revision = catalogRevision(sortedTools);
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
        `MCP tool '${tool.name}' requires experimental Tasks, which Alfred v1 does not enable`,
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
      .callTool(tool.name, validated.data, options.signal)
      .catch((err: unknown) => this.#throwProtocolError(err, protocol));
    const isToolError = isRecord(result) && result.isError === true;
    const outputValidator = this.#outputValidators.get(tool.name);
    if (!isToolError && outputValidator) {
      const structuredContent = isRecord(result) ? result.structuredContent : undefined;
      const output = outputValidator(structuredContent);
      if (!output.valid) {
        throw new McpClientError(
          "invalid_output",
          `Result from MCP tool '${tool.name}' failed its declared output schema: ${output.errorMessage}`,
        );
      }
    }
    const bounded = boundPassthroughBody(result);
    return {
      connectionId: this.#options.connectionId,
      toolName: tool.name,
      catalogRevision: catalog.revision,
      outcome: isToolError ? "tool_error" : "completed",
      result: bounded.value,
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
    if (!isMcpSessionExpiredError(err)) throw err;
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

function catalogRevision(tools: readonly Tool[]): string {
  const hash = createHash("sha256").update(canonicalJson(tools)).digest("hex");
  return `sha256:${hash}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown schema error";
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
