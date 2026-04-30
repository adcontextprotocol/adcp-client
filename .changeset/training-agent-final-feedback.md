---
'@adcp/sdk': minor
---

Address training-agent team's final feedback before 6.0.1 GA. Three SDK-side gaps surfaced during their final integration pass:

- **`TenantRegistry.get(tenantId)`** — direct tenant lookup by ID without URL parsing. Path-routed adopters who bind tenantId at their own route layer no longer have to call `resolveByRequest(canonicalHost, '/<id>/mcp')` purely as a tenantId-lookup workaround. Same `pending` / `disabled` health gate as the `resolveByXxx` helpers; `unverified` (post-healthy transient) tenants resolve normally.
- **NODE_ENV in-memory-task-registry error message** — now suggests `taskRegistry: createInMemoryTaskRegistry()` as the explicit pass-in path (recommended over the `ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1` env-flag workaround). Adopter code that says "yes I want in-memory in production" in TypeScript is the right shape.
- **`WebhooksConfig` named type export** — the `webhooks?:` option on `AdcpServerConfig` was an inline `Pick<WebhookEmitterOptions, ...>` with no public alias, forcing adopters into `as any` casts when the shape was settled. New `WebhooksConfig` named type exported from `@adcp/sdk/server` closes the gap.

Migration doc gains gotchas for the JWKS host-root resolution (with the `TenantConfig.jwksUrl` override recipe for path-routed brand identities) and the new `get(tenantId)` lookup pattern.

`agentUrls: string[]` for cutover scenarios (canonical + legacy URLs both resolving to the same tenant) deferred to a follow-up — `TenantRegistry.get(tenantId)` + adopter-side route layer is the recommended workaround for now.
