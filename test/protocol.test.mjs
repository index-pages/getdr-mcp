// JSON-RPC and MCP lifecycle over a real stdio session with dist/index.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modernMeta, ROOT, startServer, tempDir, removeDir } from "./helpers.mjs";

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

// The stateless 2026-07-28 revision: no initialize, _meta on every request.
test("2026-07-28: discover, tools/list and tools/call without a handshake", async () => {
  const dir = tempDir();
  const s = startServer(bareEnv(dir));
  const meta = modernMeta();
  const serverInfo = { name: "getdr-mcp", title: "getdr", version: "0.2.0" };
  try {
    const disc = (await s.request("server/discover", { _meta: meta })).result;
    assert.equal(disc.resultType, "complete");
    assert.deepEqual(disc.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
    assert.deepEqual(disc.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(disc._meta, { "io.modelcontextprotocol/serverInfo": serverInfo });
    assert.equal(disc.cacheScope, "public");
    assert.ok(Number.isInteger(disc.ttlMs) && disc.ttlMs >= 0);

    const list = (await s.request("tools/list", { _meta: meta })).result;
    assert.equal(list.resultType, "complete");
    assert.equal(list.tools[0].name, "get_dr");
    assert.equal(list.tools[0].description, DESCRIPTION);
    assert.equal(list.tools[0].outputSchema.type, "object");
    assert.equal(list.cacheScope, "public");
    assert.ok(Number.isInteger(list.ttlMs) && list.ttlMs >= 0);
    assert.deepEqual(list._meta, { "io.modelcontextprotocol/serverInfo": serverInfo });

    const call = await s.callTool({ targets: ["example.com"] }, meta);
    assert.equal(call.resultType, "complete");
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /getdr is not available/);

    // Unknown version: UnsupportedProtocolVersionError with the supported list.
    let res = await s.request("tools/list", { _meta: modernMeta("2099-01-01") });
    assert.equal(res.error.code, -32022);
    assert.deepEqual(res.error.data, { supported: disc.supportedVersions, requested: "2099-01-01" });

    // Required clientCapabilities missing: -32602.
    const noCaps = { ...meta };
    delete noCaps["io.modelcontextprotocol/clientCapabilities"];
    res = await s.request("tools/list", { _meta: noCaps });
    assert.equal(res.error.code, -32602);

    // ping is gone in 2026-07-28; server/discover needs the modern _meta.
    assert.equal((await s.request("ping", { _meta: meta })).error.code, -32601);
    assert.equal((await s.request("server/discover")).error.code, -32602);
  } finally {
    assert.equal(await s.close(), 0);
    removeDir(dir);
  }
  assert.equal(s.stderr, "");
});

test("dual-era: a legacy session and modern requests share one process", async () => {
  const dir = tempDir();
  const s = startServer(bareEnv(dir));
  try {
    // A dual-era client probing a legacy-only server would see an error here;
    // this server answers, and an initialize-based client still works.
    assert.equal((await s.request("server/discover", { _meta: modernMeta() })).result.resultType, "complete");
    const init = await s.initialize("2025-03-26");
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.resultType, undefined);

    // Legacy requests follow the session: no resultType, no outputSchema.
    const legacy = (await s.request("tools/list")).result;
    assert.equal(legacy.resultType, undefined);
    assert.equal(legacy.ttlMs, undefined);
    assert.equal(legacy.tools[0].outputSchema, undefined);
    assert.deepEqual((await s.request("ping")).result, {});

    // A modern request is served by its own _meta, not by the session.
    const modern = (await s.request("tools/list", { _meta: modernMeta() })).result;
    assert.equal(modern.resultType, "complete");
    assert.equal(modern.tools[0].outputSchema.type, "object");

    // initialize never negotiates the stateless revision.
    const s2 = startServer(bareEnv(dir));
    assert.equal((await s2.initialize("2026-07-28")).result.protocolVersion, "2025-11-25");
    await s2.close();
  } finally {
    await s.close();
    removeDir(dir);
  }
});
