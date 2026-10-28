#!/usr/bin/env node
// getdr-mcp: an MCP server over stdio with one tool, get_dr. stdout carries
// only protocol messages, one JSON object per line; diagnostics go to stderr.

import { cancelledId, errorResponse, PARSE_ERROR, Server, type Response } from "./protocol.js";

const server = new Server(process.env);
const pending = new Set<Promise<void>>();
// Requests in progress, and those the client cancelled: a cancelled request
// gets no response (2026-07-28 basic/transports/stdio#cancellation).
const inflight = new Set<string | number>();
const cancelled = new Set<string | number>();
let buffer = "";

function send(msg: Response): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function onLine(line: string): void {
  if (line.trim() === "") return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    send(errorResponse(null, PARSE_ERROR, "parse error: each line must be one JSON-RPC message"));
    return;
  }
  const cancel = cancelledId(msg);
  if (cancel !== undefined && inflight.has(cancel)) cancelled.add(cancel);
  const id = (msg as { id?: unknown } | null)?.id;
  const tracked = typeof id === "string" || typeof id === "number" ? id : undefined;
  if (tracked !== undefined) inflight.add(tracked);
  const p: Promise<void> = server
    .handle(msg)
    .then((res) => {
      if (tracked !== undefined) {
        inflight.delete(tracked);
        if (cancelled.delete(tracked)) return;
      }
      if (res) send(res);
    })
    .catch((err) => {
      process.stderr.write(`getdr-mcp: ${(err as Error)?.stack ?? String(err)}\n`);
    })
    .finally(() => pending.delete(p));
  pending.add(p);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    onLine(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
  }
});
// The client closed stdin: answer what is in flight, then exit.
process.stdin.on("end", () => {
  onLine(buffer);
  buffer = "";
  void Promise.allSettled([...pending]).then(() => process.exit(0));
});
// The client went away; nothing left to write to.
process.stdout.on("error", () => process.exit(0));
