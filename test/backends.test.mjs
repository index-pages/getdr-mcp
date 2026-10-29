// get_dr through both backends against the mock-backed getdr serve from the
// getdr source tree, plus fake backends for partial results.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGetdr, modernMeta, parseText, removeDir, startMock, startServer, tempDir } from "./helpers.mjs";

const TOKEN = "test-token";
const TARGETS = ["https://www.Ahrefs.com/blog/", "index-pages.com", "nodata.example", "example.org", "INDEX-PAGES.com"];

let dir;
let built;
let mock;
let noKeyMock;

before(async () => {
  dir = tempDir();
  built = buildGetdr(dir);
  if (built.skip) return;
  mock = await startMock(built.mockserve, ["-token", TOKEN]);
  noKeyMock = await startMock(built.mockserve, ["-no-key"]);
});

after(async () => {
  await mock?.stop();
  await noKeyMock?.stop();
  removeDir(dir);
});

function skipReason() {
  return built.skip ? `skipped: ${built.skip}` : false;
}

// Backend 1: GETDR_API, no getdr on PATH.
function apiEnv(url, token = TOKEN) {
  const env = { PATH: join(dir, "empty"), HOME: dir, GETDR_API: url };
  if (token) env.GETDR_SERVE_TOKEN = token;
  return env;
}

// Backend 2: the getdr binary on PATH, pointed at the same server through its
// own config file (not GETDR_API, which would select backend 1).
let configs = 0;
function binaryEnv(url, token = TOKEN, extraConfig = "") {
  const home = join(dir, `home${++configs}`);
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), `api = "${url}"\n${extraConfig}`);
  const env = {
    PATH: built.bin,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GETDR_CONFIG: join(home, "config.toml"),
    GETDR_CACHE_PATH: join(home, "cache.db"),
  };
  if (token) env.GETDR_SERVE_TOKEN = token;
  return env;
}

async function call(env, args, protocolVersion) {
  const s = startServer(env);
  try {
    await s.initialize(protocolVersion);
    return await s.callTool(args);
  } finally {
    await s.close();
    assert.equal(s.stderr, "", "nothing on the server's stderr");
  }
}

function checkSuccess(r) {
  assert.notEqual(r.isError, true, r.content[0].text);
  const text = r.content[0].text;
  const records = parseText(r);
  assert.deepEqual(JSON.parse(text), records, "the text is only the JSON array");
  assert.deepEqual(r.structuredContent, { results: records });
  for (const rec of records) {
    const keys = ["target", "dr", "version", "checked_at", "cached"];
    if (rec.error !== undefined) keys.push("error");
    assert.deepEqual(Object.keys(rec), keys);
  }
  return records;
}

test("both backends return identical arrays", async (t) => {
  if (skipReason()) return t.skip(skipReason());

  // A first lookup fills the server's cache, so every later answer is cached.
  const first = checkSuccess(await call(apiEnv(mock.url), { targets: TARGETS }));
  assert.deepEqual(
    first.map((r) => [r.target, r.dr, r.version, r.cached]),
    [
      ["ahrefs.com", 91, "dr3", false],
      ["index-pages.com", 42, "dr3", false],
      ["nodata.example", null, "dr3", false],
      ["example.org", first[3].dr, "dr3", false],
    ],
  );
  assert.equal(typeof first[3].dr, "number");
  for (const r of first) assert.match(r.checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  const api = checkSuccess(await call(apiEnv(mock.url), { targets: TARGETS }));
  const binary = checkSuccess(await call(binaryEnv(mock.url), { targets: TARGETS }));
  assert.deepEqual(api, first.map((r) => ({ ...r, cached: true })));
  assert.deepEqual(binary, api);
});

test("version and fresh reach both backends", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const args = { targets: ["ahrefs.com", "example.net"], version: "dr4", fresh: true };
  const api = checkSuccess(await call(apiEnv(mock.url), args));
  const binary = checkSuccess(await call(binaryEnv(mock.url), args));
  for (const recs of [api, binary]) {
    assert.deepEqual(recs.map((r) => [r.target, r.version, r.cached]), [
      ["ahrefs.com", "dr4", false],
      ["example.net", "dr4", false],
    ]);
  }
  assert.deepEqual(binary.map((r) => r.dr), api.map((r) => r.dr));
});

test("without a version the getdr config decides", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const env = binaryEnv(mock.url, TOKEN, 'version = "dr4"\n');
  assert.equal(checkSuccess(await call(env, { targets: ["example.com"] }))[0].version, "dr4");
  assert.equal(checkSuccess(await call(env, { targets: ["example.com"], version: "dr3" }))[0].version, "dr3");
});

test("invalid targets carry an error, the same from both backends", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const args = { targets: ["ahrefs.com", "localhost", "exa mple.com"] };
  const api = checkSuccess(await call(apiEnv(mock.url), args));
  const binary = checkSuccess(await call(binaryEnv(mock.url), args));
  assert.deepEqual(api.slice(1), [
    { target: "localhost", dr: null, version: "dr3", checked_at: null, cached: false, error: "invalid target" },
    { target: "exa mple.com", dr: null, version: "dr3", checked_at: null, cached: false, error: "invalid target" },
  ]);
  assert.deepEqual(binary.map((r) => ({ ...r, checked_at: null, cached: false })), api.map((r) => ({ ...r, checked_at: null, cached: false })));

  // A target starting with "#" is not lost as a comment on the binary path.
  const hashArgs = { targets: ["#x.com", "ahrefs.com"] };
  const hashApi = checkSuccess(await call(apiEnv(mock.url), hashArgs));
  const hashBinary = checkSuccess(await call(binaryEnv(mock.url), hashArgs));
  assert.equal(hashApi.length, 2);
  assert.deepEqual(hashBinary.map((r) => [r.target, r.dr, r.error]), hashApi.map((r) => [r.target, r.dr, r.error]));
});

test("2026-07-28 tools/call without a handshake", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  for (const env of [apiEnv(mock.url), binaryEnv(mock.url)]) {
    const s = startServer(env);
    try {
      const r = await s.callTool({ targets: ["ahrefs.com"] }, modernMeta());
      assert.equal(r.resultType, "complete");
      assert.deepEqual(r._meta, { "io.modelcontextprotocol/serverInfo": { name: "getdr-mcp", title: "getdr", version: "0.2.0" } });
      delete r.resultType;
      delete r._meta;
      assert.equal(checkSuccess(r)[0].dr, 91);
    } finally {
      await s.close();
    }
  }
});

test("protocol 2025-03-26 gets text only", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const r = await call(apiEnv(mock.url), { targets: ["ahrefs.com"] }, "2025-03-26");
  assert.equal(r.structuredContent, undefined);
  assert.equal(parseText(r)[0].dr, 91);
  assert.deepEqual(JSON.parse(r.content[0].text), parseText(r));
});

test("wrong token: tool error from both backends", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  for (const env of [apiEnv(mock.url, "wrong"), binaryEnv(mock.url, "wrong"), apiEnv(mock.url, null)]) {
    const r = await call(env, { targets: ["fresh-target.example"] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /token/);
    assert.match(r.content[0].text, /GETDR_SERVE_TOKEN/);
  }
});

test("server without an Ahrefs key (503): tool error from both backends", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  for (const env of [apiEnv(noKeyMock.url, null), binaryEnv(noKeyMock.url, null)]) {
    const r = await call(env, { targets: ["example.com"] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no Ahrefs API key/);
    assert.match(r.content[0].text, /https:\/\/index-pages\.com\/getdr#key/);
  }
});

test("unreachable GETDR_API: tool error", async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  await new Promise((r) => srv.close(r));
  const r = await call({ PATH: dir, HOME: dir, GETDR_API: url }, { targets: ["example.com"] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unreachable/);
});

// A server answering with a partial result, like getdr serve when Ahrefs
// times out for some targets.
test("partial results through the HTTP backend", async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          results: [
            { target: "a.com", dr: 12.5, version: "dr4", checked_at: "2026-10-28T12:00:00Z", cached: true },
            { target: "b.com", dr: null, version: "dr4", checked_at: null, cached: false },
          ],
        }),
      );
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const r = await call({ PATH: dir, HOME: dir, GETDR_API: url, GETDR_SERVE_TOKEN: "t0k" }, {
      targets: ["a.com", "b.com"],
      version: "dr4",
      fresh: true,
    });
    const recs = checkSuccess(r);
    assert.equal(recs.length, 2);
    assert.equal(recs[1].checked_at, null);
    assert.deepEqual(seen, [
      { url: "/dr", auth: "Bearer t0k", body: { targets: ["a.com", "b.com"], version: "dr4", fresh: true } },
    ]);

    // Without a token no Authorization header is sent; without a version
    // none is sent, so the server's default applies.
    await call({ PATH: dir, HOME: dir, GETDR_API: url }, { targets: ["a.com"] });
    assert.deepEqual(seen[1], { url: "/dr", auth: undefined, body: { targets: ["a.com"] } });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// Stand-ins for the getdr binary that print fixed output and exit codes.
// PATH holds only the fake, so the scripts use shell builtins.
function fakeBinary(name, script) {
  const bin = join(dir, name);
  mkdirSync(bin);
  writeFileSync(join(bin, "getdr"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "getdr"), 0o755);
  return { PATH: bin, HOME: dir };
}

const posixOnly = process.platform === "win32" ? "needs /bin/sh" : false;

test("binary exit codes", { skip: posixOnly }, async () => {
  // Exit 2 with records: partial result. Arguments and stdin are echoed back
  // through stderr to check how the binary is called.
  let env = fakeBinary(
    "partial",
    `while IFS= read -r l; do printf '%s\\n' "$l"; done > "$HOME/stdin.txt"; echo "$@" > "$HOME/argv.txt"
echo '{"target":"a.com","dr":1,"version":"dr3","checked_at":"2026-10-28T12:00:00Z","cached":false}'
echo '{"target":"b.com","dr":null,"version":"dr3","checked_at":null,"cached":false}'
echo 'getdr: no response for 1 target(s): HTTP 429: b.com' >&2
exit 2`,
  );
  let r = await call(env, { targets: ["a.com", "-b.com"], fresh: true });
  assert.equal(checkSuccess(r)[1].checked_at, null);
  assert.equal(readFileSync(join(dir, "argv.txt"), "utf8"), "--format json -q --fresh -f -\n");
  assert.equal(readFileSync(join(dir, "stdin.txt"), "utf8"), "a.com\n-b.com\n");
  await call(env, { targets: ["a.com"], version: "dr4" });
  assert.equal(readFileSync(join(dir, "argv.txt"), "utf8"), "--format json -q --version dr4 -f -\n");

  // Exit 2 with only invalid targets: a normal result, not a tool error.
  env = fakeBinary(
    "invalid",
    `while read -r l; do :; done
echo '{"target":"localhost","dr":null,"version":"dr3","checked_at":null,"cached":false,"error":"invalid target"}'
echo 'getdr: invalid target: localhost' >&2
exit 2`,
  );
  r = await call(env, { targets: ["localhost"] });
  assert.equal(checkSuccess(r)[0].error, "invalid target");

  // Exit 2 where every target got no response: tool error with getdr's reason.
  env = fakeBinary(
    "none",
    `while read -r l; do :; done
echo '{"target":"a.com","dr":null,"version":"dr3","checked_at":null,"cached":false}'
echo 'getdr: no response for 1 target(s): HTTP 429: a.com' >&2
exit 2`,
  );
  r = await call(env, { targets: ["a.com"] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /HTTP 429/);

  // Exit 2 without records: tool error.
  env = fakeBinary("err2", `while read -r l; do :; done; echo 'getdr: no valid targets' >&2; exit 2`);
  r = await call(env, { targets: [" "] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no valid targets/);

  // Exit 3: key missing or rejected.
  env = fakeBinary(
    "key",
    `while read -r l; do :; done; echo 'getdr: no Ahrefs API key; see https://index-pages.com/getdr#key' >&2; exit 3`,
  );
  r = await call(env, { targets: ["a.com"] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /getdr#key/);

  // Garbage on stdout: tool error, never passed through.
  env = fakeBinary("garbage", `while read -r l; do :; done; echo 'hello'`);
  r = await call(env, { targets: ["a.com"] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unexpected output/);
});

test("live Ahrefs through the binary", async (t) => {
  if (!process.env.AHREFS_KEY) return t.skip("skipped: AHREFS_KEY is not set, no live check");
  if (skipReason()) return t.skip(skipReason());
  const home = join(dir, "live");
  mkdirSync(home);
  const env = {
    PATH: built.bin,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    AHREFS_KEY: process.env.AHREFS_KEY,
  };
  const recs = checkSuccess(await call(env, { targets: ["ahrefs.com"] }));
  assert.equal(recs[0].target, "ahrefs.com");
  assert.equal(typeof recs[0].dr, "number");
});

// A cancelled request gets no response, in both eras.
test("notifications/cancelled suppresses the response", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  let arrived;
  const requestSeen = new Promise((r) => (arrived = r));
  const srv = createServer(async (req, res) => {
    req.resume();
    arrived();
    await held;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ results: [{ target: "a.com", dr: 1, version: "dr3", checked_at: "2026-10-28T12:00:00Z", cached: false }] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const s = startServer({ PATH: dir, HOME: dir, GETDR_API: `http://127.0.0.1:${srv.address().port}` });
  try {
    await s.initialize();
    s.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "get_dr", arguments: { targets: ["a.com"] } } }));
    await requestSeen;
    s.notify("notifications/cancelled", { requestId: "slow", reason: "test" });
    await new Promise((r) => setImmediate(r));
    release();
    await new Promise((r) => setTimeout(r, 200));
    await s.request("ping");
    assert.equal(s.lines.filter((l) => JSON.parse(l).id === "slow").length, 0);
  } finally {
    await s.close();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
