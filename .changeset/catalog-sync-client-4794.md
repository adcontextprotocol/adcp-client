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
catalog.on('product.created', ({ event, synthetic }) => { ... });
catalog.on('product.priced', ({ event, synthetic }) => { ... });
catalog.on('product.removed', ({ event, synthetic }) => { ... });
catalog.on('signal.priced', ({ event, synthetic }) => { ... });
catalog.on('catalog.bulk_change', ({ event }) => { ... });
catalog.on('resyncing', ({ reason }) => { /* 'bulk_change' | 'retention_expired' | 'manual' */ });
catalog.on('event', ({ event, synthetic }) => { /* fires for every catalog change */ });
```

Per-event-type listeners fire for both live-mode feed events AND auto-poll/manual diff-emits — adopters write one set of handlers and the SDK takes care of which mode produced the event.

**Authoritative vs synthetic events.** Events delivered from the agent's change feed are AUTHORITATIVE — they carry the seller's UUID v7 `event_id` and the documented `applies_to` cache scope. Events emitted during `refresh()` / `'auto-poll'` mode are SYNTHESIZED by the SDK from a diff of previous-vs-fresh state; they carry locally generated event IDs (NOT v7) and `synthetic: true` on the emit envelope. Adopters writing event_ids to a dedupe table MUST check `synthetic` before storing — synthetic IDs don't satisfy the cursor-ordering invariant.

**Recovery semantics:**

- `catalog.bulk_change` events trigger an immediate re-bootstrap (the spec's recommended fast-forward when a single operation touches many entities). `resyncing` fires before the re-bootstrap with `reason: 'bulk_change'`.
- `RETENTION_EXPIRED` (HTTP 410) triggers a re-bootstrap with `reason: 'retention_expired'`.
- Mode upgrades (manual → auto-poll → live, when an agent adopts new spec surfaces) are picked up automatically by the capability-refresh loop (default: every 24 hours; tunable via `capabilityRefreshIntervalMs`).

**Cursor persistence:** `cursorStore` defaults to in-memory (cursor lost on restart). Long-running consumers pass `FileCursorStore` (re-exported from `@adcp/sdk/catalog-sync`) to survive restarts. The `CursorStore` interface gained a `clearCursor()` method so retention-expired recovery resets to a clean `null` rather than relying on an empty-string sentinel.

**Security guards:**

- **SSRF defense:** `feedOrigin` construction throws if the protocol is not `http:` or `https:`. Rejects `file:`, `data:`, `blob:` schemes that would otherwise let a misconfigured tenant config turn the poll loop into a credential-leaking SSRF primitive.
- **Response-size cap:** `maxFeedResponseBytes` (default 25 MB) bounds the size of a single `GET /catalog/events` response; bodies exceeding the cap are rejected before parsing. Protects mirror processes from hostile or runaway agents that stream unbounded chunked responses.

**Auth headers and token rotation:** `feedHeaders` accepts either a static `Record<string, string>` (captured by reference; mutate to rotate) OR an async function `() => Headers | Promise<Headers>` (called on every poll, picks up token rotation without restart).

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
