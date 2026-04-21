---
'@adcp/client': minor
---

Add uniform-error-response fuzz invariant (adcontextprotocol/adcp-client#731). `adcp fuzz` now runs a paired-probe check on referential lookup tools asserting byte-equivalent error responses for "exists but inaccessible" vs "does not exist" — the AdCP spec MUST from error-handling.mdx (landed in adcp#2689, hardened in adcp#2691).

Two modes:
- **Baseline** (default, single token): two fresh UUIDs probed per tool. Catches id-echo, header divergence, MCP `isError` / A2A `task.status.state` divergence. Always runs.
- **Cross-tenant** (new `--auth-token-cross-tenant` flag + `ADCP_AUTH_TOKEN_CROSS_TENANT` env var): seeder runs as tenant A, invariant probes as tenant B against the seeded id + a fresh UUID. Catches the full cross-tenant existence-leak surface.

Comparator enforces identical `error.code` / `message` / `field` / `details`, HTTP status, MCP `isError`, A2A `task.status.state`, and response headers with a closed allowlist (`Date`, `Server`, `Server-Timing`, `Age`, `Via`, `X-Request-Id`, `X-Correlation-Id`, `X-Trace-Id`, `Traceparent`, `Tracestate`, `CF-Ray`, `X-Amz-Cf-Id`, `X-Amz-Request-Id`, `X-Amzn-Trace-Id`). `Content-Length`, `Vary`, `Content-Type`, `ETag`, `Cache-Control`, and rate-limit headers MUST match.

Tool coverage: `get_property_list`, `get_content_standards`, `get_media_buy_delivery`, `get_creative_delivery`, `tasks_get`. Extending is additive via `TOOL_ID_CONFIG` in `src/lib/conformance/invariants/uniformError.ts`.

**Public API:**
- New option: `RunConformanceOptions.authTokenCrossTenant?: string`
- New report field: `ConformanceReport.uniformError: UniformErrorReport[]`
- New CLI flag: `--auth-token-cross-tenant <token>`

**Security:** response headers are redacted at capture time when they name a credential (`Authorization`, `X-Adcp-Auth`, `Cookie`, etc.), and bearer tokens echoed in response bodies are masked — no credential ever lands in a stored report.

**Docs:** `docs/guides/VALIDATE-YOUR-AGENT.md` has a new "Uniform-error-response invariant (paired probe)" subsection including the preparation checklist for two-tenant testing. `skills/build-seller-agent/SKILL.md` § Protocol-Wide Requirements adds "Resolve-then-authorize" as a universal MUST; `skills/build-governance-agent/SKILL.md` cross-references it.
