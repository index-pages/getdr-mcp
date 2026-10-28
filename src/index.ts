#!/usr/bin/env node
// getdr-mcp: an MCP server over stdio with one tool, get_dr. stdout carries
// only protocol messages, one JSON object per line; diagnostics go to stderr.

import { errorResponse, PARSE_ERROR, Server, type Response } from "./protocol.js";

const server = new Server(process.env);
const pending = new Set<Promise<void>>();
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
  const p: Promise<void> = server
    .handle(msg)
    .then((res) => {
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
