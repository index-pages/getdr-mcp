// Checks that a release is ready to publish: package.json, server.json and
// the built code agree on the version (and match the tag, when given), and
// the packed tarball holds dist/index.js with its shebang.
//
//   node scripts/check-release.mjs [v1.2.3]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const fail = (msg) => {
  console.error(`check-release: ${msg}`);
  process.exit(1);
};
const readJSON = (f) => JSON.parse(readFileSync(f, "utf8"));

if (!existsSync("dist/index.js")) fail("dist/index.js is missing, run npm run build first");

const pkg = readJSON("package.json");
const server = readJSON("server.json");
const builtVersion = readFileSync("dist/version.js", "utf8").match(/VERSION = "([^"]+)"/)?.[1];
const versions = {
  "package.json": pkg.version,
  "server.json version": server.version,
  "server.json packages[0].version": server.packages?.[0]?.version,
  "dist/version.js": builtVersion,
};
const tag = process.argv[2];
if (tag !== undefined && tag !== `v${pkg.version}`) fail(`tag ${tag} does not match package.json version ${pkg.version}`);
for (const [where, v] of Object.entries(versions)) {
  if (v !== pkg.version) fail(`version mismatch: ${where} is ${v}, package.json is ${pkg.version}`);
}
if (server.name !== pkg.mcpName) fail(`server.json name ${server.name} differs from package.json mcpName ${pkg.mcpName}`);
if (server.packages?.[0]?.identifier !== pkg.name) fail(`server.json packages[0].identifier is not ${pkg.name}`);

// Pack for real (scripts off, so nothing rebuilds behind our back) and read
// the tarball: a gzipped tar of 512-byte headers, each followed by its data.
const dir = mkdtempSync(join(tmpdir(), "getdr-mcp-pack-"));
const files = new Map();
let filename;
try {
  [{ filename }] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { encoding: "utf8" }),
  );
  const tar = gunzipSync(readFileSync(join(dir, filename)));
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    const field = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    if (!name) break;
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim(), 8);
    files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const bin = files.get("package/dist/index.js");
if (!bin) fail(`the tarball has no dist/index.js (files: ${[...files.keys()].join(", ")})`);
if (!bin.toString("utf8").startsWith("#!/usr/bin/env node\n")) fail("dist/index.js in the tarball has no shebang");
console.log(`check-release: ${pkg.name}@${pkg.version} ok, ${files.size} files in ${filename}`);
