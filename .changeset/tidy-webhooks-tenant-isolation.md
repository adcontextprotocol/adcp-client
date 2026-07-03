---
'@adcp/sdk': major
---

Security: webhook emitter is SSRF-safe by default, and `createTenantStore` gains an opt-in `resolve` isolation gate.

**Breaking — webhook delivery default.** `createWebhookEmitter` / `createAdcpServer({ webhooks })` now default their HTTP client to `createPinAndBindFetch()` instead of `globalThis.fetch`. This defeats DNS-rebinding / SSRF against the buyer-supplied `push_notification_config.url` (https-only; loopback, private, and cloud-metadata ranges denied). In-process harnesses that deliver to a loopback `http://127.0.0.1` receiver must now opt in explicitly:

```ts
import { createPinAndBindFetch, LOOPBACK_OK_WEBHOOK_SSRF_POLICY } from '@adcp/sdk/server';

createAdcpServer({
  webhooks: { signerKey, fetch: createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY }) },
});
```

Passing `fetch: globalThis.fetch` restores the previous unguarded behavior (only do so behind your own URL validation).

**`createTenantStore` — `refAccess` gate on `resolve`.** Added `refAccess?: 'ref-routed' | 'auth-scoped'` (default `'ref-routed'`, non-breaking). `'ref-routed'` preserves the agency-hub model where one credential may resolve any tenant's account by ref. `'auth-scoped'` makes `accounts.resolve` fail closed when a buyer-supplied ref points at a tenant other than the authenticated principal's — closing a cross-tenant read/mutate path for non-trusted-buyer deployments. Corrected the `createTenantStore` / `account.ts` docs, which previously implied `resolve` was always an isolation gate; it is not unless `refAccess: 'auth-scoped'` is set or a `resolve-presets` guard is composed.
