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
2. `getdr` is on `PATH` – runs `getdr --format json -q [--version V] [--fresh] -f -` with the targets on
   stdin, no shell. The binary uses its own config, cache and key (`AHREFS_KEY`), or its own `api` setting.
3. Neither – the tool returns an error with setup instructions.

Install the binary with `go install github.com/index-pages/getdr@latest` or from
[Releases](https://github.com/index-pages/getdr/releases), then get a free Ahrefs API key:
[index-pages.com/getdr#key](https://index-pages.com/getdr#key).

Both backends return the same records. Calls time out after 120 seconds.

## Tool

`get_dr` – "Ahrefs Domain Rating (0–100) for domains or URLs, via getdr by Index Pages".

| argument | type | |
|---|---|---|
| `targets` | string[] | required, non-empty; domains or URLs |
| `version` | `"dr3"` or `"dr4"` | DR formula, default `dr3`; values are not comparable between versions |
| `fresh` | boolean | ignore the cache and fetch again |

Targets are normalized by getdr: a URL becomes its host, `www.` is dropped, everything is lower-cased and
duplicates are removed. Results follow the input order.

## Output

The text result is a JSON array with one record per target, then the attribution line:

```
[
{"target":"ahrefs.com","dr":91,"version":"dr3","checked_at":"2026-10-28T12:00:00Z","cached":true},
{"target":"nodata.example","dr":null,"version":"dr3","checked_at":"2026-10-28T12:00:00Z","cached":false}
]

Domain Rating by Ahrefs – https://ahrefs.com/
```

The record is the getdr JSON contract, the same as `getdr --format json` and `getdr serve`. `dr` is `null`
when Ahrefs has no data; `checked_at` is `null` too when there was no response (timeout, rate limit). Clients on
MCP protocol 2025-06-18 or later also get `structuredContent` – `{"results": […], "attribution": "…"}` – and an
`outputSchema` for it.

Errors come back as tool errors (`isError: true`) with getdr's message:

- some targets got no response – the records are returned, followed by a note naming those targets;
- no target got a response – an error with the reason;
- getdr server answered 401 – the token is missing or wrong, set `GETDR_SERVE_TOKEN`;
- getdr server answered 503, or the binary exited with code 3 – the Ahrefs key is missing or rejected;
- the server is unreachable, the binary failed, or a call timed out.

Supported MCP protocol versions: 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05.

## Attribution

Domain Rating data comes from [Ahrefs](https://ahrefs.com/) and is subject to the
[Domain Rating License](https://ahrefs.com/legal/domain-rating-license), which requires the attribution
"Domain Rating by Ahrefs". Every result ends with it. Keep it when you publish the numbers.

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

## License

MIT, see [LICENSE](LICENSE). Made by [Index Pages](https://index-pages.com).
