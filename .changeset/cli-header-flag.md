---
"@adcp/sdk": minor
---

Add `-H KEY=VALUE` / `--header KEY=VALUE` CLI flag for arbitrary request headers

The CLI now accepts `-H KEY=VALUE` (repeatable, curl convention) to send custom headers alongside `--auth`. Headers can also be persisted per-agent via `--save-auth -H x-adcp-tenant=acme` and are stored in `~/.adcp/config.json`. The auth header always wins on conflict (with a warning). Fixes a gap that blocked multi-tenant localhost routing (e.g. `x-adcp-tenant`) in verify scripts.

Also fixes a library bug where `AgentConfig.headers` (already typed and plumbed in the protocols layer) was silently discarded on the MCP path when no auth token was present.
