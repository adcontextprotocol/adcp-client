---
'@adcp/client': minor
---

Thin response builders for four tools whose handlers previously had no typed wrapper, plus per-variant constructors for `acquire_rights`:

- **`acquireRightsResponse(data)`** — envelope wrapper on the `AcquireRightsResponse` union.
- **`acquireRightsAcquired({...})`, `acquireRightsPendingApproval({...})`, `acquireRightsRejected({...})`** — per-variant constructors. A coding agent typing `acquireRightsAcqu…` gets the right variant's required-field shape directly without reading a 4-variant union.
- **`syncAccountsResponse(data)`** — envelope wrapper on `SyncAccountsResponse`.
- **`syncGovernanceResponse(data)`** — envelope wrapper on `SyncGovernanceResponse`.
- **`reportUsageResponse(data)`** with `.acceptAll(request, { errors })` shortcut — the `.acceptAll` form computes `accepted = usage.length - errors.length` so the common "ack all / ack all minus validated failures" cases are one call.

All four are auto-applied via `createAdcpServer`'s `TOOL_META` — handlers return domain objects and the framework wraps. Also exported from `@adcp/client` and `@adcp/client/server` for manual use.

**Scope note** (per test-agent-team review): these builders are **only** MCP envelope wrappers — they do not enforce schema constraints like `credentials.minLength: 32`, `authentication.schemes.length === 1`, or `creative_manifest.format_id` object shape. Those belong in wire-level Zod validation (already available as `createAdcpServer({ validation: { responses: 'strict' } })`, tracked for default-on). Validation in builders would be the wrong layer — it only fires for tools whose handlers reach the wrapper, misses manual-tool paths, and encourages per-tool workarounds instead of fixing the generator + validator.
