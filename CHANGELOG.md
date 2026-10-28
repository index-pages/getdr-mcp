# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] – 2026-10-28

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
- MCP protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05.
- `server.json` for the MCP Registry.

[Unreleased]: https://github.com/index-pages/getdr-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/index-pages/getdr-mcp/releases/tag/v0.1.0
