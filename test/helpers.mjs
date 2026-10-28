// Test helpers: spawn the compiled server and speak JSON-RPC to it over
// stdio; build and run the getdr binary and its mock-backed serve.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = join(ROOT, "dist", "index.js");

// The getdr source tree: $GETDR_SRC, else the sibling bin/ checkout.
export const GETDR_SRC = process.env.GETDR_SRC || resolve(ROOT, "..", "bin");

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "getdr-mcp-test-"));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Starts dist/index.js with exactly the given environment.
export function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const lines = [];
  let stderr = "";
  let buf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (s) => (stderr += s));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (s) => {
    buf += s;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const msg = JSON.parse(line); // throws if anything but JSON reaches stdout
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  let next = 1;
  const exited = new Promise((res) => child.on("close", (code) => res(code)));
  return {
    lines,
    get stderr() {
      return stderr;
    },
    sendRaw(text) {
      child.stdin.write(text + "\n");
    },
    // Resolves with the response that carries this id.
    waitFor(id) {
      return new Promise((res) => waiting.set(id, res));
    },
    request(method, params) {
      const id = next++;
      const p = this.waitFor(id);
      const msg = { jsonrpc: "2.0", id, method };
      if (params !== undefined) msg.params = params;
      this.sendRaw(JSON.stringify(msg));
      return p;
    },
    notify(method, params) {
      const msg = { jsonrpc: "2.0", method };
      if (params !== undefined) msg.params = params;
      this.sendRaw(JSON.stringify(msg));
    },
    async initialize(protocolVersion = "2025-11-25") {
      const res = await this.request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "getdr-mcp-test", version: "0" },
      });
      this.notify("notifications/initialized");
      return res;
    },
    async callTool(args) {
      const res = await this.request("tools/call", { name: "get_dr", arguments: args });
      if (res.error) throw new Error(`tools/call failed: ${JSON.stringify(res.error)}`);
      return res.result;
    },
    // Closes stdin and waits for the server to exit.
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}

// The JSON array at the start of a get_dr text result.
export function parseText(result) {
  const text = result.content[0].text;
  const end = text.indexOf("\n]\n");
  return JSON.parse(end >= 0 ? text.slice(0, end + 2) : text.slice(0, text.indexOf("\n")));
}

// Builds getdr and mockserve from GETDR_SRC into dir. Returns null (with the
// reason) when Go or the source tree is missing.
export function buildGetdr(dir) {
  if (!existsSync(join(GETDR_SRC, "go.mod"))) return { skip: `getdr source not found at ${GETDR_SRC} (set GETDR_SRC)` };
  const env = { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" };
  try {
    execFileSync("go", ["version"], { env, stdio: "ignore" });
  } catch {
    return { skip: "go is not installed" };
  }
  const bin = join(dir, "bin");
  const exe = process.platform === "win32" ? ".exe" : "";
  execFileSync("go", ["build", "-o", join(bin, "getdr" + exe), "."], { cwd: GETDR_SRC, env, stdio: "inherit" });
  execFileSync("go", ["build", "-o", join(dir, "mockserve" + exe), "./testdata/mockserve"], {
    cwd: GETDR_SRC,
    env,
    stdio: "inherit",
  });
  return { bin, mockserve: join(dir, "mockserve" + exe) };
}

// Starts mockserve on a free port; resolves with its URL and a stop function.
export function startMock(mockserve, args = []) {
  return new Promise((res, rej) => {
    const child = spawn(mockserve, ["-listen", "127.0.0.1:0", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s) => {
      err += s;
      const m = err.match(/getdr API on (http:\/\/[0-9.:]+)/);
      if (m) {
        child.stderr.removeAllListeners("data");
        child.stderr.resume();
        const exited = new Promise((r) => child.on("close", r));
        res({
          url: m[1],
          stop: () => {
            child.kill("SIGTERM"); // mockserve removes its temporary cache on SIGTERM
            return exited;
          },
        });
      }
    });
    child.on("error", rej);
    child.on("close", (code) => rej(new Error(`mockserve exited with ${code}: ${err}`)));
  });
}
