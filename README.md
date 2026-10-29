# getdr-mcp

`getdr-mcp` is a small open-source [MCP](https://modelcontextprotocol.io/) server by
[Index Pages](https://index-pages.com) that gives AI agents one tool, `get_dr`: Ahrefs Domain Rating (DR) for
domains or URLs. It is a thin front for [getdr](https://index-pages.com/getdr) – it asks a getdr server or the
`getdr` binary and makes no Ahrefs requests of its own. Stdio transport, no runtime dependencies. Docs:
[index-pages.com/getdr](https://index-pages.com/getdr).

## Setup

Add it to your MCP client (Claude Desktop, Claude Code, Cursor and others use this shape):

```json
{
  "mcpServers": {
    "getdr": {
      "command": "npx",
      "args": ["-y", "getdr-mcp"]
    }
  }
}
```

That uses the `getdr` binary on your `PATH`. To use a getdr server on your network instead:

```json
{
  "mcpServers": {
    "getdr": {
      "command": "npx",
      "args": ["-y", "getdr-mcp"],
      "env": {
        "GETDR_API": "http://lan-host:8080",
        "GETDR_SERVE_TOKEN": "s3cret"
      }
    }
  }
}
```

Requires Node.js 18 or later.

## Backends

Checked on every call, in this order:

1. `GETDR_API` is set – one `POST $GETDR_API/dr` to that getdr server (`getdr serve`), with
   `Authorization: Bearer $GETDR_SERVE_TOKEN` when the token is set. The server holds the Ahrefs key and the
   shared cache, so this machine needs neither.
2. `getdr` is on `PATH` – runs `getdr --format json -q --version V [--fresh] -f -` with the targets on
   stdin, no shell. The binary uses its own config, cache and key (`AHREFS_KEY`), or its own `api` setting.
3. Neither – the tool returns an error with setup instructions.

Install the binary with `go install github.com/index-pages/getdr@latest` or from
[Releases](https://github.com/index-pages/getdr/releases), then get a free Ahrefs API key:
[index-pages.com/getdr#key](https://index-pages.com/getdr#key).

Both backends return the same records. Calls time out after 120 seconds.

Proxies: the HTTP backend uses Node's built-in `fetch`, which ignores `HTTP_PROXY`/`HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY=1` is set (Node 22.21 or later, or 24 and later; older versions have no built-in proxy
support). The binary backend honours `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` as usual.

## Tool

`get_dr` – "Ahrefs Domain Rating (0–100) for domains or URLs, via getdr by Index Pages".

| argument | type | |
|---|---|---|
| `targets` | string[] | required, non-empty; domains or URLs |
| `version` | `"dr3"` or `"dr4"` | DR formula, default `dr3` (always sent explicitly, so a server or config set to `dr4` does not change it); values are not comparable between versions |
| `fresh` | boolean | ignore the cache and fetch again |

Targets are normalized by getdr: a URL becomes its host, `www.` is dropped, everything is lower-cased and
duplicates are removed. Results follow the input order.

## Output

The text result is a JSON array with one record per target, and nothing else:

```
[
{"target":"ahrefs.com","dr":91,"version":"dr3","checked_at":"2026-10-28T12:00:00Z","cached":true},
{"target":"nodata.example","dr":null,"version":"dr3","checked_at":"2026-10-28T12:00:00Z","cached":false}
]
```

The record is the getdr JSON contract, the same as `getdr --format json` and `getdr serve`. `dr` is `null`
when Ahrefs has no data; `checked_at` is `null` too when there was no response (timeout, rate limit). Clients on
MCP protocol 2025-06-18 or later also get `structuredContent` – `{"results": […]}` – and an
`outputSchema` for it.

When some targets got no response, the result is a normal one: all records, followed by a note naming those
targets. Everything else comes back as a tool error (`isError: true`) with getdr's message:

- no target got a response – an error with the reason;
- getdr server answered 401 – the token is missing or wrong, set `GETDR_SERVE_TOKEN`;
- getdr server answered 503, or the binary exited with code 3 – the Ahrefs key is missing or rejected;
- the server is unreachable, the binary failed, or a call timed out.

Supported MCP protocol versions: 2026-07-28 (stateless: `server/discover` and per-request `_meta`, no
handshake) and the `initialize`-based 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, served side by side.

## Attribution

Domain Rating data comes from [Ahrefs](https://ahrefs.com/) and is subject to the
[Domain Rating License](https://ahrefs.com/legal/domain-rating-license), which requires the attribution
"Domain Rating by Ahrefs" wherever you publish the numbers. The tool result carries only the data, with
no attribution in it.

getdr is not affiliated with Ahrefs.

## No telemetry

getdr-mcp connects to exactly one place: the getdr server in `GETDR_API`, when you set it. Otherwise it only
starts the `getdr` binary. No telemetry, no update checks, no analytics, no pings. Requests carry the
User-Agent `getdr-mcp/<version> (+https://index-pages.com/getdr)`. You can verify this in the source: the only
outgoing request and the only child process are in `src/backends.ts`.

## Development

```sh
npm ci
npm run build
npm test
```

The backend tests build `getdr` and its mock-backed server from the getdr source tree (`../bin`, or
`GETDR_SRC`) and need Go; without it they are skipped. The live check runs only when `AHREFS_KEY` is set.

## Releasing

Bump the version in `package.json`, `server.json` (twice) and `src/version.ts`, update `CHANGELOG.md`, then
push a tag `vX.Y.Z`. `.github/workflows/release.yml` builds, runs the tests against the getdr source at the
same tag, checks that every version matches the tag and that the packed tarball holds `dist/index.js` with its
shebang, and publishes with npm trusted publishing (OIDC, no token, provenance included).

Trusted publishing can only be configured for a package that already exists on npm, so the first release is
published by hand once: `npm login`, then `npm run release`. Right after that, add the trusted publisher on
npmjs.com (package Settings → Trusted publishing: GitHub Actions, `index-pages` / `getdr-mcp`, workflow
`release.yml`); the workflow has to complete its first publish within 2 days or the configuration expires.

For any manual publish use `npm run release` (build, tests, `check-release`, `npm publish`), never a bare
`npm publish`: with install scripts disabled (`ignore-scripts`) `prepack` does not run and the package would
ship without `dist/`. `prepack` stays as a fallback for setups that run scripts.

MCP Registry (manual, after the npm release): install `mcp-publisher` from the
[registry releases](https://github.com/modelcontextprotocol/registry/releases), run
`mcp-publisher login github` as a member of the `index-pages` GitHub org, then `mcp-publisher publish` in
the repo root. It reads `server.json` and checks `mcpName` in the published npm package.

## License

MIT, see [LICENSE](LICENSE). Made by [Index Pages](https://index-pages.com).
