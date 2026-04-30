# Multi-tenant hosting — TenantRegistry

When one process hosts many publishers (typical SaaS deployment), use `createTenantRegistry` — wraps `createAdcpServerFromPlatform` with per-tenant config, health gates, and JWKS validation.

```ts
import { createTenantRegistry, serve } from '@adcp/sdk/server';

const registry = createTenantRegistry({
  resolveTenant: async (req) => {
    // Map host header / OAuth subject / path prefix to a tenant id
    return { tenantId: extractTenantFromHost(req.headers.host) };
  },
  buildPlatform: async (tenantId) => {
    // Load tenant config from your DB
    const tenantConfig = await loadTenant(tenantId);
    return new MyPlatform(tenantConfig);
  },
  // Health gates: 'healthy' / 'unverified' / 'disabled'
  // Disabled tenants get 503 SERVICE_UNAVAILABLE without invoking the platform.
});

serve(registry.host, { port: process.env.PORT });
```

## Per-tenant config

Each tenant can override `capabilities.config` independently:

```ts
buildPlatform: async (tenantId) => {
  const cfg = await loadTenant(tenantId);
  return {
    capabilities: {
      ...,
      config: { networkId: cfg.gamNetworkId, manualApprovalOperations: cfg.approvalOps },
    },
    accounts: { ... },
    sales: { ... },
  };
};
```

## Per-tenant ctxMetadata

Each `createAdcpServerFromPlatform` call gets its own `ctxMetadataStore` instance — multi-tenant hosts pass per-tenant store handles, not a shared one. Account scoping handles the rest (`account.id` in the storage key).

See `REFERENCE.md` for the full multi-tenant section + admin router for ops visibility.
