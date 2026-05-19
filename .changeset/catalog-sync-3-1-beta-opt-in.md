---
'@adcp/sdk': minor
---

feat(types, validation): opt-in support for AdCP 3.1.0-beta.1 (catalog-sync cluster)

Adopters can now pin `adcpVersion: '3.1.0-beta.1'` (or `'3.1-beta'`) to validate against the beta schemas including the catalog-sync cluster from [adcontextprotocol/adcp#4767](https://github.com/adcontextprotocol/adcp/pull/4767): `if_catalog_version` / `if_pricing_version` conditional fetch on `get_products` / `get_signals`, wholesale `discovery_mode` for signals, the `catalog_change_feed` capability stanza, and the new `core/catalog-event.json` + `core/catalog-events-response.json` schemas.

The SDK's primary pin stays at the GA `ADCP_VERSION` — this is a side-bundle, not a default move. The `latest` symlink in `schemas/cache/` continues to point at the GA pin.

```ts
import { AdCPClient } from '@adcp/sdk';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CatalogEvent,
  CatalogEventsResponse,
} from '@adcp/sdk/types/v3-1-beta';

const client = new AdCPClient({
  agentUrl: 'https://salesagent.example.com',
  adcpVersion: '3.1-beta', // or '3.1.0-beta.1' for full-semver pinning
});

const req: GetProductsRequest = {
  buying_mode: 'wholesale',
  if_catalog_version: 'v2026-05-18T08:00:00Z-acme-rev412',
};
```

Pulls from the cosign-verified upstream tarball via `npm run sync-schemas:3.1-beta` (sha256-pinned through the official protocol release artifact). Restores `schemas/registry/registry.yaml` and protocol-managed skills to the primary-pin state on every opt-in sync, so the beta cache never leaks into surfaces the SDK ships against the GA pin.

CatalogSync client (the consumer-facing change-feed mirror) lands in a follow-on PR; this opt-in unblocks adopters building their own mirror loop directly against the typed surface today.
