# Multi-tenant hosting — TenantRegistry

When one process hosts many publishers (typical SaaS deployment), use `createTenantRegistry` — wraps `createAdcpServerFromPlatform` with per-tenant config, health gates, and JWKS validation.

```ts
import { createTenantRegistry, serve } from '@adcp/sdk/server';

// 1. Create the registry (once, at startup)
const registry = createTenantRegistry({
  defaultServerOptions: {
    name: 'my-multi-tenant-host',
    version: '1.0.0',
    validation: { requests: 'strict', responses: 'strict' },
  },
  // jwksValidator: createNoopJwksValidator()  // dev/test only — skip brand.json roundtrip
  autoValidate: true,
});

// 2. Register each tenant explicitly (call register() once per tenant)
//    Load config from your DB, KMS, etc. at startup.
await registry.register('tenant_a', {
  agentUrl: 'https://tenant-a.example.com',
  platform: new MyPlatform(await loadTenantConfig('tenant_a')),
  signingKey: await loadSigningKeyFromKms('tenant_a'),  // optional in 3.x; required in 4.0
  label: 'Tenant A',
}, { awaitFirstValidation: true });

// 3. Wire into serve() — resolve the tenant per request by host
serve(ctx => {
  const resolved = registry.resolveByHost(ctx.host);
  if (!resolved) throw new Error(`unknown host: ${ctx.host}`);
  return resolved.server;
}, { port: process.env.PORT });
```

## Per-tenant health

Health is per-tenant and isolated — one bad tenant doesn't block others:

| State | Meaning | Traffic |
|---|---|---|
| `pending` | Registered; first JWKS validation not yet completed | **Refused** (503) |
| `healthy` | JWKS validated at least once | Served normally |
| `unverified` | Was healthy; latest recheck failed transiently | Served (graceful degradation) |
| `disabled` | Permanent JWKS failure (key not in JWKS, malformed brand.json) | **Refused** until admin calls `recheck()` |

## Runtime admin operations

Register a new tenant without restarting (e.g., admin-save webhook):

```ts
// POST /admin/tenants/:tenantId/activate  (gate with mTLS or signed admin token)
await registry.register(tenantId, {
  agentUrl: row.agentUrl,
  platform: new MyPlatform(await loadTenantConfig(tenantId)),
}, { awaitFirstValidation: true });
```

Re-validate JWKS after key rotation (**zero traffic gap**):

```ts
// POST /admin/tenants/:tenantId/recheck
const status = await registry.recheck(tenantId);
// status.health transitions: disabled → healthy (if brand.json now matches)
```

Update platform config (unregister → re-register, **brief ~503 gap**):

```ts
// ⚠️  resolveByHost returns null between these two calls (~<10ms for in-process)
registry.unregister(tenantId);
await registry.register(tenantId, { agentUrl, platform: new MyPlatform(newConfig) },
  { awaitFirstValidation: true });
```

Remove a tenant — `resolveByHost` returns null immediately:

```ts
registry.unregister(tenantId);
// In-flight requests that already resolved a server reference complete normally.
// New resolve calls return null → respond with 503/404.
```

## Per-tenant config

Each tenant registers its own `DecisioningPlatform` implementation independently.
There is no shared `capabilities.config` override — per-tenant configuration is
expressed via your platform's constructor or dependency-injection pattern:

```ts
registry.register(tenantId, {
  agentUrl: row.agentUrl,
  platform: new MyPlatform({
    networkId: row.gamNetworkId,
    manualApprovalOps: row.approvalOps,
  }),
});
```

## Per-tenant ctxMetadata

Each `createAdcpServerFromPlatform` call (one per tenant) gets its own
`ctxMetadataStore` instance — multi-tenant hosts pass per-tenant store handles,
not a shared one. Account scoping handles request isolation
(`account.id` is part of the storage key).

## Worked example

See `examples/decisioning-platform-multi-tenant-db.ts` for a complete DB-driven
startup pattern with concurrent-recheck CI tests and admin-operation helpers.

See `REFERENCE.md` for the admin router (ops visibility into registry health).
