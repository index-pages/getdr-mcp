// MCP over stdio is newline-delimited JSON-RPC 2.0. This module answers one
// parsed message at a time; index.ts does the line framing.
//
// Two protocol eras are served side by side ("dual-era", 2026-07-28
// basic/versioning#backward-compatibility-with-initialization-based-versions):
// - legacy (2024-11-05 … 2025-11-25): an initialize handshake fixes the
//   version for the process;
// - modern (2026-07-28): no handshake, every request names its version and
//   client capabilities in _meta, results carry resultType.

import { callGetDr, toolDefinition } from "./tool.js";
import { VERSION } from "./version.js";

// Newest first. initialize answers with the requested legacy version when we
// support it, else with the newest legacy one.
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MODERN_VERSIONS = ["2026-07-28"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

// structuredContent and outputSchema exist since 2025-06-18.
const STRUCTURED_SINCE = "2025-06-18";

// Per-request _meta keys (2026-07-28 basic/index#meta).
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

// The tool list only changes with a new release, which means a new process.
// Cache hints are required on server/discover and tools/list
// (2026-07-28 server/utilities/caching#cacheable-results).
const CACHE_TTL_MS = 3_600_000;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const SERVER_INFO = { name: "getdr-mcp", title: "getdr", version: VERSION };
const CAPABILITIES = { tools: { listChanged: false } };

type Id = string | number | null;

export interface Response {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// The protocol version that applies to one request.
interface Context {
  version: string;
  modern: boolean;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(id: Id, code: number, message: string, data?: unknown): Response {
  const error: Response["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The request id a notifications/cancelled message refers to, if it is one.
export function cancelledId(msg: unknown): string | number | undefined {
  if (!isObject(msg) || msg.method !== "notifications/cancelled" || "id" in msg || !isObject(msg.params)) {
    return undefined;
  }
  const id = msg.params.requestId;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

export class Server {
  // Legacy version agreed in initialize; null until then.
  protocolVersion: string | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  // Returns the response to send, or null for notifications and for
  // responses the client sends us (we never send requests, so we ignore them).
  async handle(msg: unknown): Promise<Response | null> {
    if (Array.isArray(msg)) {
      return errorResponse(null, INVALID_REQUEST, "JSON-RPC batches are not supported");
    }
    if (!isObject(msg) || msg.jsonrpc !== "2.0") {
      const id = isObject(msg) ? validId(msg.id) : null;
      return errorResponse(id, INVALID_REQUEST, 'invalid request: expected a JSON-RPC 2.0 object with "jsonrpc": "2.0"');
    }
    const hasId = "id" in msg;
    if (typeof msg.method !== "string") {
      if (!("result" in msg) && !("error" in msg)) {
        return errorResponse(validId(msg.id), INVALID_REQUEST, "invalid request: missing method");
      }
      return null;
    }
    if (!hasId) return null; // notification: notifications/initialized, notifications/cancelled, …
    if (typeof msg.id !== "string" && typeof msg.id !== "number") {
      return errorResponse(null, INVALID_REQUEST, "invalid request: id must be a string or a number");
    }
    const id = msg.id;
    if (msg.params !== undefined && !isObject(msg.params)) {
      return errorResponse(id, INVALID_PARAMS, "params must be an object");
    }
    const params = msg.params ?? {};
    try {
      const ctx = this.context(params);
      const result = (await this.dispatch(msg.method, params, ctx)) as Record<string, unknown>;
      if (ctx.modern) {
        // 2026-07-28 basic/index#result-responses: resultType is required;
        // serverInfo in every result's _meta is a SHOULD.
        result.resultType = "complete";
        result._meta = { [META_SERVER_INFO]: SERVER_INFO };
      }
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (err instanceof RpcError) return errorResponse(id, err.code, err.message, err.data);
      return errorResponse(id, INTERNAL_ERROR, `internal error: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  // A request that names its protocol version in _meta is served by that
  // version alone (2026-07-28 basic/index#statelessness); one without it
  // belongs to the legacy session.
  private context(params: Record<string, unknown>): Context {
    const meta = isObject(params._meta) ? params._meta : undefined;
    const requested = meta?.[META_VERSION];
    if (requested === undefined) {
      return { version: this.protocolVersion ?? LEGACY_VERSIONS[0], modern: false };
    }
    if (typeof requested !== "string") {
      throw new RpcError(INVALID_PARAMS, `_meta["${META_VERSION}"] must be a string`);
    }
    if (!SUPPORTED_VERSIONS.includes(requested)) {
      throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: SUPPORTED_VERSIONS,
        requested,
      });
    }
    const modern = MODERN_VERSIONS.includes(requested);
    if (modern && !isObject(meta?.[META_CLIENT_CAPS])) {
      throw new RpcError(INVALID_PARAMS, `missing _meta["${META_CLIENT_CAPS}"]`);
    }
    return { version: requested, modern };
  }

  private async dispatch(method: string, params: Record<string, unknown>, ctx: Context): Promise<unknown> {
    const structured = ctx.version >= STRUCTURED_SINCE; // ISO dates compare as strings
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "server/discover":
        if (!ctx.modern) {
          throw new RpcError(INVALID_PARAMS, `server/discover needs _meta["${META_VERSION}"]: "${MODERN_VERSIONS[0]}"`);
        }
        return {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: CAPABILITIES,
          ttlMs: CACHE_TTL_MS,
          cacheScope: "public",
        };
      case "ping":
        if (ctx.modern) break; // removed in 2026-07-28
        return {};
      case "tools/list": {
        const result: Record<string, unknown> = { tools: [toolDefinition(structured)] };
        if (ctx.modern) Object.assign(result, { ttlMs: CACHE_TTL_MS, cacheScope: "public" });
        return result;
      }
      case "tools/call":
        return this.callTool(params, structured);
    }
    throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
  }

  private initialize(params: Record<string, unknown>): unknown {
    const requested = params.protocolVersion;
    if (typeof requested !== "string") {
      throw new RpcError(INVALID_PARAMS, "initialize: protocolVersion must be a string", {
        supported: LEGACY_VERSIONS,
      });
    }
    this.protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return {
      protocolVersion: this.protocolVersion,
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
    };
  }

  private async callTool(params: Record<string, unknown>, structured: boolean): Promise<unknown> {
    if (typeof params.name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call: name must be a string");
    }
    if (params.name !== "get_dr") {
      throw new RpcError(INVALID_PARAMS, `unknown tool: ${params.name}`);
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      throw new RpcError(INVALID_PARAMS, "tools/call: arguments must be an object");
    }
    return callGetDr(params.arguments ?? {}, { structured, env: this.env });
  }
}

function validId(id: unknown): Id {
  return typeof id === "string" || typeof id === "number" ? id : null;
}
