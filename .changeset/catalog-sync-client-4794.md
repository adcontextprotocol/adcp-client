---
'@adcp/sdk': minor
---

feat(catalog-sync): `CatalogSync` client — in-memory catalog mirror for AdCP 3.1 agents

`CatalogSync` is the consumer-facing companion to the AdCP 3.1 catalog-sync cluster ([adcontextprotocol/adcp#4794](https://github.com/adcontextprotocol/adcp/issues/4794)). It mirrors a sales or signals agent's full priced catalog in memory and keeps it current via the best sync strategy the agent supports — change-feed polling, conditional-fetch probes, or manual refresh — selected automatically from the agent's `get_adcp_capabilities` response.

```ts
import { AdCPClient } from '@adcp/sdk';
import { CatalogSync } from '@adcp/sdk/catalog-sync';

const client = new AdCPClient({ agentUrl, adcpVersion: '3.1-beta' });

const catalog = new CatalogSync({
  client,
  feedOrigin: agentUrl, // origin of GET /catalog/events
  feedHeaders: { Authorization: `Bearer ${token}` },
});

catalog.on('product.priced', ({ event }) => {
  const p = event.payload as { product_id: string };
  console.log('reprice:', p.product_id);
});

await catalog.start();
console.log(`Mirroring ${catalog.products.count} products via ${catalog.mode} mode`);

const ctv = catalog.products.search({ format_ids: ['video_ctv_1080p_30s'] });
```

**Mode selection (automatic from capabilities):**

| Agent declares                                 | `catalog.mode` | Behavior                                                                                                                             |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog_change_feed.supported: true`          | `'live'`       | Wholesale bootstrap, then poll `GET /catalog/events`. Lowest latency.                                                                |
| `catalog_versioning.supported: true` (no feed) | `'auto-poll'`  | Wholesale bootstrap, then re-probe with `if_catalog_version` at `probeIntervalMs`. On version change, re-fetch and diff-emit events. |
| Neither (pre-3.1 agents)                       | `'manual'`     | Wholesale bootstrap on `start()`. No background sync. `refresh()` triggers re-bootstrap and diff-emits any detected changes.         |

**Read API:**

- `catalog.products.list()` / `catalog.products.get(id)` / `catalog.products.search(filter)` — zero-latency in-memory reads.
- `catalog.signals.list()` / `catalog.signals.get(id)` / `catalog.signals.search(filter)` — same shape for signals (when the agent supports `discovery_mode: 'wholesale'`; flagged via `catalog.signals.queryable`).
- `catalog.mode` / `catalog.capabilities` / `catalog.lastSyncedAt` / `catalog.lastEventAt` — introspection for UI mode badges and observability.

**Event API:**

```ts
catalog.on('product.created', ({ event }) => { ... });
catalog.on('product.priced', ({ event }) => { ... });
catalog.on('product.removed', ({ event }) => { ... });
catalog.on('signal.priced', ({ event }) => { ... });
catalog.on('catalog.bulk_change', ({ event }) => { ... });
catalog.on('bulk_resync', ({ reason }) => { /* 'bulk_change' | 'retention_expired' | 'manual' */ });
catalog.on('event', ({ event }) => { /* fires for every catalog change */ });
```

Per-event-type listeners fire for both live-mode feed events AND auto-poll/manual diff-emits — adopters write one set of handlers and the SDK takes care of which mode produced the event.

**Recovery semantics:**

- `catalog.bulk_change` events trigger an immediate re-bootstrap (the spec's recommended fast-forward when a single operation touches many entities). `bulk_resync` fires before the re-bootstrap with `reason: 'bulk_change'`.
- `RETENTION_EXPIRED` (HTTP 410 or `error.code` envelope) triggers a re-bootstrap with `reason: 'retention_expired'`.
- Mode upgrades (manual → auto-poll → live, when an agent adopts new spec surfaces) are picked up automatically by the capability-refresh loop (default: every 24 hours; tunable via `capabilityRefreshIntervalMs`).

**Cursor persistence:** `cursorStore` defaults to in-memory (cursor lost on restart). Long-running consumers pass `FileCursorStore` (re-exported from `@adcp/sdk/catalog-sync`) to survive restarts.

**What's NOT in this release** (per the spec — follow-on PRs):

- Webhook subscription lifecycle (`POST /catalog/subscriptions`) — adopters needing low-latency notifications stay in polling-only `'live'` mode for now; webhook landing is gated on AdCP 3.1 GA and the upstream webhook conformance harness.
- Python / Go SDK ports — TypeScript first; ports follow on the same release cadence as `RegistrySync`.

The SDK's primary version pin stays at GA. `CatalogSync` is available at any `adcpVersion` — it gates behavior on capability stanzas, not on the client's pin. Against pre-3.1 agents it falls through cleanly to `'manual'` mode.

Imports:

```ts
// Recommended namespace import
import { CatalogSync } from '@adcp/sdk/catalog-sync';
import type { CatalogSyncConfig, CatalogSyncMode, ProductFilter, SignalFilter } from '@adcp/sdk/catalog-sync';
```
