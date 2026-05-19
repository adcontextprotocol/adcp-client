---
'@adcp/sdk': minor
---

feat(types, validation): opt-in support for AdCP 3.1.0-beta.1 (catalog-sync cluster)

Adopters can now pin `adcpVersion: '3.1-beta'` to validate against the beta schemas including the catalog-sync cluster from [adcontextprotocol/adcp#4767](https://github.com/adcontextprotocol/adcp/pull/4767):

- **Conditional fetch:** `if_catalog_version` / `if_pricing_version` request fields on `get_products` and `get_signals`, plus `catalog_version`, `pricing_version`, `cache_scope`, and `unchanged` on responses — buyers cache catalogs and probe with one cheap round-trip.
- **Wholesale signals:** `discovery_mode: 'wholesale'` on `get_signals` (symmetric with `buying_mode: 'wholesale'` on `get_products`) — enumerate the full priced signal catalog without a brief.
- **Catalog change feed:** `catalog_change_feed` stanza in `get_adcp_capabilities` plus the new `core/catalog-event.json` (9-branch discriminated union) and `core/catalog-events-response.json` schemas — the wire shape buyers poll at `GET /catalog/events` to maintain a near-real-time mirror.

The SDK's primary pin stays at the GA `ADCP_VERSION` — this is a side-bundle, not a default move. The `latest` symlink in `schemas/cache/` continues to point at the GA pin.

```ts
import { AdCPClient } from '@adcp/sdk';
import type * as V31Beta from '@adcp/sdk/types/v3-1-beta';

const client = new AdCPClient({
  agentUrl: 'https://salesagent.example.com',
  adcpVersion: '3.1-beta', // canonical: release-precision; survives beta.N → beta.N+1
});

const req: V31Beta.GetProductsRequest = {
  buying_mode: 'wholesale',
  if_catalog_version: 'v2026-05-18T08:00:00Z-acme-rev412',
};
```

**Importing the beta types.** Prefer `import * as V31Beta` (namespaced) when you're mixing 3.0 and 3.1-beta types in the same file — `GetProductsRequest`, `GetProductsResponse`, and several other names exist in both `@adcp/sdk/types` and `@adcp/sdk/types/v3-1-beta` with different shapes, and flat-named imports will collide.

**Until the `CatalogSync` client lands** (consumer-facing mirror with mode selection, conditional fetch, and change-feed polling — follow-on PR), adopters build their own mirror loop directly against the typed surface:

```ts
import type * as V31Beta from '@adcp/sdk/types/v3-1-beta';

let catalogVersion: string | undefined;
async function probe(): Promise<void> {
  const res = (await client.callTool('get_products', {
    buying_mode: 'wholesale',
    ...(catalogVersion ? { if_catalog_version: catalogVersion } : {}),
  })) as V31Beta.GetProductsResponse;
  if (res.unchanged) return; // catalog state is current
  catalogVersion = res.catalog_version;
  // ...apply res.products to local mirror
}
```

**Pinning.** Use `'3.1-beta'` (release-precision) as the canonical pin — it matches what sellers advertise in `supported_versions` and survives the `beta.1 → beta.2` bundle rename without a code change. Pin `'3.1.0-beta.1'` (full semver) only if you need bit-fidelity for cross-version interop tests.

**Refresh.** `npm run sync-schemas:3.1-beta` pulls the cosign-verified upstream tarball; `npm run generate-types:3.1-beta` regenerates the typed surface. The wrapper restores `schemas/registry/registry.yaml` and protocol-managed skills to the primary-pin state on every opt-in sync, so the beta cache never leaks into surfaces the SDK ships against the GA pin.
