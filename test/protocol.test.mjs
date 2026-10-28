// JSON-RPC and MCP lifecycle over a real stdio session with dist/index.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startServer, tempDir, removeDir } from "./helpers.mjs";

const DESCRIPTION = "Ahrefs Domain Rating (0–100) for domains or URLs, via getdr by Index Pages";

// An environment with neither GETDR_API nor getdr on PATH.
function bareEnv(dir) {
  return { PATH: dir, HOME: dir };
}

test("initialize negotiates the protocol version", async () => {
  const dir = tempDir();
  try {
    for (const [asked, got] of [
      ["2025-11-25", "2025-11-25"],
      ["2025-06-18", "2025-06-18"],
      ["2025-03-26", "2025-03-26"],
      ["2024-11-05", "2024-11-05"],
      ["2099-01-01", "2025-11-25"],
    ]) {
      const s = startServer(bareEnv(dir));
      const res = await s.initialize(asked);
      assert.equal(res.result.protocolVersion, got, `asked ${asked}`);
      assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
      assert.equal(res.result.serverInfo.name, "getdr-mcp");
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      assert.equal(res.result.serverInfo.version, pkg.version);
      assert.equal(await s.close(), 0);
      assert.equal(s.stderr, "");
    }
  } finally {
    removeDir(dir);
  }
});

test("handshake, ping, tools/list and JSON-RPC errors", async () => {
  const dir = tempDir();
  const s = startServer(bareEnv(dir));
  try {
    const bad = await s.request("initialize", { capabilities: {} });
    assert.equal(bad.error.code, -32602);

    await s.initialize();
    assert.deepEqual((await s.request("ping")).result, {});

    const list = await s.request("tools/list");
    assert.equal(list.result.tools.length, 1);
    const tool = list.result.tools[0];
    assert.equal(tool.name, "get_dr");
    assert.equal(tool.description, DESCRIPTION);
    assert.deepEqual(tool.inputSchema.required, ["targets"]);
    assert.deepEqual(tool.inputSchema.properties.version.enum, ["dr3", "dr4"]);
    assert.equal(tool.inputSchema.properties.fresh.type, "boolean");
    assert.equal(tool.outputSchema.type, "object");

    assert.equal((await s.request("resources/list")).error.code, -32601);
    assert.equal((await s.request("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
    assert.equal((await s.request("tools/call", { arguments: {} })).error.code, -32602);

    // Parse error and invalid requests answer with id null (or the id if any).
    s.sendRaw("{not json");
    let res = await s.waitFor(null);
    assert.equal(res.error.code, -32700);
    s.sendRaw(JSON.stringify({ id: 77, method: "ping" }));
    res = await s.waitFor(77);
    assert.equal(res.error.code, -32600);
    s.sendRaw("[]");
    res = await s.waitFor(null);
    assert.equal(res.error.code, -32600);

    // Notifications, even unknown ones, get no answer; the next request does.
    s.notify("notifications/whatever");
    s.notify("notifications/cancelled", { requestId: 1 });
    const before = s.lines.length;
    await s.request("ping");
    assert.equal(s.lines.length, before + 1);
  } finally {
    assert.equal(await s.close(), 0);
    removeDir(dir);
  }
  for (const line of s.lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  assert.equal(s.stderr, "");
});

test("older protocol versions get no outputSchema", async () => {
  const dir = tempDir();
  const s = startServer(bareEnv(dir));
  try {
    await s.initialize("2025-03-26");
    const tool = (await s.request("tools/list")).result.tools[0];
    assert.equal(tool.outputSchema, undefined);
  } finally {
    await s.close();
    removeDir(dir);
  }
});

test("invalid arguments are tool errors", async () => {
  const dir = tempDir();
  const s = startServer(bareEnv(dir));
  try {
    await s.initialize();
    for (const args of [
      {},
      { targets: [] },
      { targets: "a.com" },
      { targets: [1] },
      { targets: ["a.com\nb.com"] },
      { targets: ["a.com"], version: "dr9" },
      { targets: ["a.com"], fresh: "yes" },
      { targets: ["a.com"], ttl: "1d" },
    ]) {
      const r = await s.callTool(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.equal(r.content[0].type, "text");
    }
  } finally {
    await s.close();
    removeDir(dir);
  }
});

test("no backend: tool error with install instructions", async () => {
  const dir = tempDir();
  const s = startServer(bareEnv(dir));
  try {
    await s.initialize();
    const r = await s.callTool({ targets: ["example.com"] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /GETDR_API/);
    assert.match(r.content[0].text, /https:\/\/index-pages\.com\/getdr/);
    assert.equal(r.structuredContent, undefined);
  } finally {
    await s.close();
    removeDir(dir);
  }
});

test("an empty GETDR_API counts as unset", async () => {
  const dir = tempDir();
  const s = startServer({ ...bareEnv(dir), GETDR_API: " " });
  try {
    await s.initialize();
    const r = await s.callTool({ targets: ["example.com"] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /getdr is not available/);
  } finally {
    await s.close();
    removeDir(dir);
  }
});
