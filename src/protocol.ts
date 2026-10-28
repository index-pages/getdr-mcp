// MCP over stdio is newline-delimited JSON-RPC 2.0. This module answers one
// parsed message at a time; index.ts does the line framing.

import { callGetDr, toolDefinition } from "./tool.js";
import { VERSION } from "./version.js";

// Newest first. A client asking for one of these gets it back; anything else
// gets the newest, and the client decides whether it can continue.
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// structuredContent and outputSchema exist since 2025-06-18.
const STRUCTURED_SINCE = "2025-06-18";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type Id = string | number | null;

export interface Response {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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

export class Server {
  // Protocol version agreed in initialize; null until then.
  protocolVersion: string | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private structured(): boolean {
    // ISO dates compare as strings. Before initialize, assume the newest.
    return (this.protocolVersion ?? PROTOCOL_VERSIONS[0]) >= STRUCTURED_SINCE;
  }

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
      const result = await this.dispatch(msg.method, params);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (err instanceof RpcError) return errorResponse(id, err.code, err.message, err.data);
      return errorResponse(id, INTERNAL_ERROR, `internal error: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: [toolDefinition(this.structured())] };
      case "tools/call":
        return this.callTool(params);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  private initialize(params: Record<string, unknown>): unknown {
    const requested = params.protocolVersion;
    if (typeof requested !== "string") {
      throw new RpcError(INVALID_PARAMS, "initialize: protocolVersion must be a string", {
        supported: PROTOCOL_VERSIONS,
      });
    }
    this.protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "getdr-mcp", title: "getdr", version: VERSION },
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    if (typeof params.name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call: name must be a string");
    }
    if (params.name !== "get_dr") {
      throw new RpcError(INVALID_PARAMS, `unknown tool: ${params.name}`);
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      throw new RpcError(INVALID_PARAMS, "tools/call: arguments must be an object");
    }
    return callGetDr(params.arguments ?? {}, { structured: this.structured(), env: this.env });
  }
}

function validId(id: unknown): Id {
  return typeof id === "string" || typeof id === "number" ? id : null;
}
