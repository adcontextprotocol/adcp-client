---
'@adcp/sdk': patch
---

fix(cli): make `--allow-http` work end-to-end for local dev loops

Two paths previously ignored `--allow-http` and broke connections to `http://localhost` agents:

- `MCPOAuthProvider.validateResourceURL` rejected non-HTTPS RFC 9728 resource URLs unconditionally (`Server at http://localhost:.../mcp advertised non-HTTPS resource URL: http://...`). The provider now accepts an `allowHttp` option that lifts the HTTPS check, and the CLI threads `--allow-http` through to `createCLIOAuthProvider` / `ensureOAuthTokensForAlias`.
- `detectProtocol` refused to probe `http://` agent cards because the probe policy reads `ADCP_ALLOW_INTERNAL_PROBES` once at module load (`Failed to detect protocol: Refusing to fetch non-HTTPS URL: http://localhost:.../.well-known/agent.json`). The CLI now sets that env var before any library require when `--allow-http` is in argv, so the existing well-tested gate widens consistently.

Default behavior is unchanged: HTTPS is required unless the caller explicitly opts in.
