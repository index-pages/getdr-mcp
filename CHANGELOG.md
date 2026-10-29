# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Records of invalid targets carry `"error":"invalid target"` (also in
  `outputSchema`). Through a getdr server, a target its Ahrefs refuses is no
  longer reported as "no response".
- The release workflow publishes `server.json` to the MCP Registry.

### Fixed

- Through the binary, a target starting with `#` was skipped as a comment of
  the `-f -` list; such lists now go as arguments.

### Changed

- The binary backend needs getdr 0.2.0 or newer (for the `error` field).
- Without `version`, the getdr server's or binary's config decides; before,
  `dr3` was always sent.
- The text result is only the JSON array: the note after it about targets
  without a response is gone (their `checked_at` is `null`). An error for
  "no response for any target" quotes getdr instead of guessing a cause.

### Removed

- The Ahrefs attribution line at the end of the `get_dr` text result and the
  `attribution` field of `structuredContent` (and of `outputSchema`).

## [0.1.0] - 2026-10-28

### Added

- `getdr-mcp`: MCP server over stdio, run with `npx -y getdr-mcp`; no runtime
  dependencies.
- Tool `get_dr`: Ahrefs Domain Rating for domains or URLs (`targets`, optional
  `version` `dr3`/`dr4` and `fresh`).
- Backends in order: a getdr server from `GETDR_API` (bearer token from
  `GETDR_SERVE_TOKEN`), else the `getdr` binary on `PATH`; a tool error with
  setup instructions when neither is there.
- Result: the getdr JSON records as text, followed by the Ahrefs attribution;
  `structuredContent` with an `outputSchema` for protocol 2025-06-18 and later.
- MCP protocol versions 2026-07-28 (stateless, with `server/discover`) and the
  `initialize`-based 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05.
- A request cancelled with `notifications/cancelled` gets no response.
- `server.json` for the MCP Registry.
- Release workflow with npm trusted publishing, and `npm run release` with a
  version and tarball check for manual publishes.

[Unreleased]: https://github.com/index-pages/getdr-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/index-pages/getdr-mcp/releases/tag/v0.1.0
