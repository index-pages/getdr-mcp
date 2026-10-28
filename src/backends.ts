// The two ways to get Domain Rating: a getdr server (GETDR_API) or the getdr
// binary on PATH. Both return the same record shape. Nothing here talks to
// Ahrefs directly.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { HOMEPAGE, USER_AGENT } from "./version.js";

// One result, in the key order of the getdr JSON contract.
export interface DrRecord {
  target: string;
  dr: number | null;
  version: string;
  checked_at: string | null;
  cached: boolean;
}

export interface Query {
  targets: string[];
  version?: "dr3" | "dr4";
  fresh?: boolean;
}

export interface Outcome {
  records: DrRecord[];
  // Why some targets got no response, when the backend said so.
  detail: string;
}

export type Backend = (q: Query) => Promise<Outcome>;

// A failure to report to the model as a tool error.
export class BackendError extends Error {}

// Both the HTTP request and the binary run are bounded by this. A getdr
// server may need several rate-limited Ahrefs batches for a long list.
export const TIMEOUT_MS = 120_000;

const MAX_DETAIL = 2000;

export function isNoResponse(r: DrRecord): boolean {
  return r.dr === null && r.checked_at === null;
}

export function toRecord(v: unknown): DrRecord {
  const o = v as { [k: string]: unknown } | null;
  if (
    typeof o !== "object" ||
    o === null ||
    typeof o.target !== "string" ||
    !(o.dr === null || typeof o.dr === "number") ||
    typeof o.version !== "string" ||
    !(o.checked_at === null || typeof o.checked_at === "string") ||
    typeof o.cached !== "boolean"
  ) {
    throw new Error(`unexpected record ${JSON.stringify(v)?.slice(0, 200)}`);
  }
  return { target: o.target, dr: o.dr, version: o.version, checked_at: o.checked_at, cached: o.cached };
}

function clip(s: string): string {
  s = s.trim();
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + "…" : s;
}

// ---- getdr server -------------------------------------------------------

function serverError(body: string): string {
  try {
    const e = JSON.parse(body) as { error?: unknown };
    if (typeof e.error === "string" && e.error) return e.error;
  } catch {
    // not JSON, fall through
  }
  return clip(body) || "(empty body)";
}

export async function viaApi(base: string, token: string | undefined, q: Query): Promise<Outcome> {
  const url = base.replace(/\/+$/, "") + "/dr";
  const where = `getdr server ${base} (GETDR_API)`;
  const body: { [k: string]: unknown } = { targets: q.targets };
  if (q.version) body.version = q.version;
  if (q.fresh) body.fresh = true;
  const headers: { [k: string]: string } = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let status: number;
  let text: string;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new BackendError(`${where} did not answer within ${TIMEOUT_MS / 1000} s. Try again later or with fewer targets.`);
    }
    const why = e.cause?.code ?? e.cause?.message ?? e.message;
    throw new BackendError(`${where} is unreachable: ${why}. Check that GETDR_API points to a running getdr serve.`);
  }

  switch (status) {
    case 200:
      break;
    case 401:
      throw new BackendError(
        `${where} rejected the request: ${serverError(text)}. Set GETDR_SERVE_TOKEN to the server's token.`,
      );
    case 503:
      throw new BackendError(`${where}: ${serverError(text)}`);
    default:
      throw new BackendError(`${where}: HTTP ${status}: ${serverError(text)}`);
  }
  try {
    const parsed = JSON.parse(text) as { results?: unknown };
    if (!Array.isArray(parsed.results)) throw new Error('no "results" array');
    const records = parsed.results.map(toRecord);
    const detail = records.some(isNoResponse) ? "the getdr server got no answer from Ahrefs (timeout or rate limit)" : "";
    return { records, detail };
  } catch (err) {
    throw new BackendError(`${where} sent an unexpected response: ${(err as Error).message}`);
  }
}

// ---- getdr binary -------------------------------------------------------

// Looks up getdr in PATH the way a shell would, without running a shell.
// Empty and relative PATH entries are skipped so the working directory never
// supplies the binary.
export function findBinary(env: NodeJS.ProcessEnv): string | null {
  const win = process.platform === "win32";
  const pathVar = (win ? (env.Path ?? env.PATH) : env.PATH) ?? "";
  const names = win
    ? (env.PATHEXT ?? ".EXE;.COM").split(";").filter(Boolean).map((ext) => "getdr" + ext.toLowerCase())
    : ["getdr"];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const p = join(dir, name);
      try {
        if (!statSync(p).isFile()) continue;
        if (!win) accessSync(p, constants.X_OK);
        return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function viaBinary(bin: string, env: NodeJS.ProcessEnv, q: Query): Promise<Outcome> {
  // Targets go through stdin (-f -): no shell, no argv length limits, and a
  // target that starts with "-" is never read as a flag.
  const argv = ["--format", "json", "-q"];
  if (q.version) argv.push("--version", q.version);
  if (q.fresh) argv.push("--fresh");
  argv.push("-f", "-");

  return new Promise((resolve, reject) => {
    const fail = (msg: string) => reject(new BackendError(msg));
    let child;
    try {
      child = spawn(bin, argv, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      fail(`cannot run ${bin}: ${(err as Error).message}`);
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => errOut.push(b));
    child.stdin.on("error", () => {
      // the binary exited before reading everything; its exit code tells why
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(`cannot run ${bin}: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = clip(Buffer.concat(errOut).toString("utf8"));
      if (timedOut) {
        fail(`getdr did not finish within ${TIMEOUT_MS / 1000} s. Try again later or with fewer targets.`);
        return;
      }
      if (code !== 0 && code !== 2) {
        if (code === 3) {
          fail(stderr || `getdr: Ahrefs API key missing or rejected; see ${HOMEPAGE}#key`);
        } else {
          fail(`getdr exited with ${code ?? signal}${stderr ? `: ${stderr}` : ""}`);
        }
        return;
      }
      let records: DrRecord[];
      try {
        records = stdout
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => toRecord(JSON.parse(l)));
      } catch (err) {
        fail(`getdr printed unexpected output: ${(err as Error).message}`);
        return;
      }
      // Exit 2 without records is an error (bad flag, cache, no valid
      // targets); with records it means some targets got no response.
      if (code === 2 && records.length === 0) {
        fail(stderr || "getdr failed (exit 2)");
        return;
      }
      resolve({ records, detail: code === 2 ? stderr : "" });
    });
    child.stdin.end(q.targets.join("\n") + "\n");
  });
}
