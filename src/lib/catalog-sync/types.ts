import type { SingleAgentClient } from '../core/SingleAgentClient';
import type { CursorStore } from '../registry/cursor-store';
import type * as V31Beta from '../types/v3-1-beta';

/**
 * Operating mode for a {@link CatalogSync} instance, resolved from the
 * agent's capability stanza at `start()` time.
 *
 * - `'live'` — agent declares `catalog_change_feed.supported: true`.
 *   Bootstrap via wholesale, then poll `GET /catalog/events` to apply
 *   events incrementally. Lowest latency, lowest seller cost.
 * - `'auto-poll'` — agent declares `catalog_versioning.supported: true`
 *   but no change feed. Bootstrap via wholesale, then re-probe with
 *   `if_catalog_version` at `probeIntervalMs`. On version change,
 *   re-fetch and diff-emit events.
 * - `'manual'` — agent declares neither. Bootstrap via wholesale on
 *   `start()`. No background activity; `refresh()` triggers a re-bootstrap
 *   and diff-emits any detected changes.
 *
 * The top-level `catalog.mode` is the lowest mode across the two entity
 * tracks — `catalog.products.mode` and `catalog.signals.mode` can differ
 * when the agent declares per-entity capability vectors (e.g., products
 * feed supported but signals wholesale only).
 */
export type CatalogSyncMode = 'manual' | 'auto-poll' | 'live';

/**
 * Lifecycle state of the sync engine.
 */
export type CatalogSyncState = 'idle' | 'bootstrapping' | 'syncing' | 'error';

/**
 * Subset of `SingleAgentClient` that {@link CatalogSync} actually uses.
 * Lets tests inject a minimal stub without constructing a full client.
 */
export interface CatalogSyncClient {
  getAdcpCapabilities: SingleAgentClient['getAdcpCapabilities'];
  getProducts: SingleAgentClient['getProducts'];
  getSignals: SingleAgentClient['getSignals'];
}

/**
 * Configuration for a {@link CatalogSync} instance.
 *
 * The SDK's primary version pin (`ADCP_VERSION`) stays at GA; the catalog-
 * sync surfaces only activate when the agent declares `catalog_change_feed`
 * and/or `catalog_versioning` in its `get_adcp_capabilities` response.
 * Against pre-3.1 agents the sync still works in `'manual'` mode — bootstrap
 * via wholesale, no background sync.
 */
export interface CatalogSyncConfig {
  /** Pre-configured client (or stub) for tool calls against the target agent. */
  client: CatalogSyncClient;

  /**
   * Origin of the agent's change-feed endpoint. Used to construct
   * `<feedOrigin>/catalog/events` polls in `'live'` mode. Optional in
   * `'manual'` and `'auto-poll'` modes (no feed traffic).
   *
   * Recommended: set this even when you expect manual mode — the SDK falls
   * through gracefully if the agent later advertises the feed.
   */
  feedOrigin?: string;

  /**
   * Headers to send with `GET /catalog/events` polls. The change-feed
   * endpoint lives on the agent's HTTP origin, outside the MCP/A2A
   * tool-call path, so the SDK can't reuse the client's transport auth
   * automatically. Adopters supply auth headers explicitly.
   *
   * Required when `feedOrigin` is set and the agent's change feed
   * requires authentication (the common case).
   */
  feedHeaders?: Record<string, string>;

  /** Change-feed poll interval in `'live'` mode. Default: 30000 (30s). */
  pollIntervalMs?: number;

  /**
   * Version-probe interval in `'auto-poll'` mode. Default: 600000 (10
   * minutes). The spec's recommended cadence: cheap conditional fetch is
   * fast enough that polling more often than every few minutes wastes
   * round trips; less often than ~30 minutes risks stale mirrors for
   * dayparted/makegood pricing changes.
   */
  probeIntervalMs?: number;

  /**
   * How often `start()` should re-probe the agent's capability vector to
   * detect a mode upgrade (e.g., manual → auto-poll → live as the agent
   * adopts new spec surfaces). Default: 86_400_000 (24h). Set to 0 to
   * disable.
   */
  capabilityRefreshIntervalMs?: number;

  /**
   * Cursor persistence for the change-feed walk. Default: in-memory
   * (cursor lost on process restart). For long-running consumers use
   * `FileCursorStore` from `@adcp/sdk` (re-exported from
   * `src/lib/registry/cursor-store.ts`).
   */
  cursorStore?: CursorStore;

  /** Error callback for background poll/probe failures. */
  onError?: (error: Error) => void;

  /**
   * Inject a `fetch` implementation for the change-feed HTTP calls.
   * Default: `globalThis.fetch`. Tests override to mock the feed.
   */
  fetch?: typeof fetch;
}

/**
 * The resolved capability vector after `start()` probes the agent.
 * Snapshot at probe time; if the agent's capabilities change, the SDK
 * re-resolves on the next `capabilityRefreshIntervalMs` tick.
 */
export interface ResolvedCapabilities {
  /** Whether the agent declares `catalog_change_feed.supported`. */
  changeFeed: boolean;
  /** Whether the agent supports `if_catalog_version` conditional fetch. */
  catalogVersioning: boolean;
  /** Whether the agent supports webhook subscriptions on the feed. */
  webhooks: boolean;
  /** Event types the agent advertises on its feed (empty when changeFeed === false). */
  eventTypes: readonly string[];
  /** Retention window in days (the agent's guarantee). Undefined when changeFeed === false. */
  retentionWindowDays?: number;
}

/**
 * EventEmitter contract. Catalog change events fire per-type so callers
 * can `catalog.on('product.priced', ...)` without filtering. The wildcard
 * `'event'` channel emits every catalog change for callers that want a
 * single sink (audit logs, downstream queues).
 *
 * Lifecycle events:
 * - `bootstrap` — initial sync completed; replica is current.
 * - `sync` — change-feed poll cycle completed (`'live'` mode) OR diff
 *   cycle completed (`'auto-poll'` / `'manual'` after `refresh()`).
 * - `mode_resolved` — emitted on `start()` after the capability probe
 *   picks a mode. Useful for UI mode badges.
 * - `bulk_resync` — emitted before a `catalog.bulk_change` or
 *   `RETENTION_EXPIRED` recovery re-bootstrap.
 * - `error` — background poll/probe error. Non-fatal; sync stays in
 *   `'syncing'` and retries on the next tick.
 * - `stateChange` — fires on every {@link CatalogSyncState} transition.
 */
export interface CatalogSyncEvents {
  bootstrap: [{ productCount: number; signalCount: number; mode: CatalogSyncMode }];
  sync: [{ eventsApplied: number; cursor?: string | undefined }];
  mode_resolved: [{ mode: CatalogSyncMode; capabilities: ResolvedCapabilities }];
  bulk_resync: [{ reason: 'bulk_change' | 'retention_expired' | 'manual' }];
  error: [{ error: Error }];
  stateChange: [{ from: CatalogSyncState; to: CatalogSyncState }];
  // Per-event-type fan-outs. Payload is the full CatalogEvent so callers
  // can read `event_id`, `created_at`, and the discriminated `payload`.
  event: [{ event: V31Beta.CatalogEvent }];
  'product.created': [{ event: V31Beta.CatalogEvent }];
  'product.updated': [{ event: V31Beta.CatalogEvent }];
  'product.priced': [{ event: V31Beta.CatalogEvent }];
  'product.removed': [{ event: V31Beta.CatalogEvent }];
  'signal.created': [{ event: V31Beta.CatalogEvent }];
  'signal.updated': [{ event: V31Beta.CatalogEvent }];
  'signal.priced': [{ event: V31Beta.CatalogEvent }];
  'signal.removed': [{ event: V31Beta.CatalogEvent }];
  'catalog.bulk_change': [{ event: V31Beta.CatalogEvent }];
}

/**
 * Client-side filter for {@link CatalogSync.products.search}.
 *
 * Filters operate over the in-memory replica — no round trips. All
 * specified dimensions use AND; values within arrays use OR. Pass an
 * empty object to match all products.
 */
export interface ProductFilter {
  /** Match products whose `format_ids` overlap with the listed format IDs. */
  format_ids?: string[];
  /** Match products whose `delivery_type` is in the listed set. */
  delivery_types?: string[];
  /** Match products by `product_id` exact match (use `.get()` for single-ID lookup). */
  product_ids?: string[];
  /** Free-text substring match across `name` and `description` (case-insensitive). */
  text?: string;
}

/**
 * Client-side filter for {@link CatalogSync.signals.search}. Same
 * semantics as {@link ProductFilter} but over the signal index.
 */
export interface SignalFilter {
  /** Match signals by `signal_agent_segment_id` exact match. */
  signal_agent_segment_ids?: string[];
  /** Match signals whose `signal_type` is in the listed set. */
  signal_types?: string[];
  /** Match signals by `data_provider` substring match (case-insensitive). */
  data_provider?: string;
  /** Free-text substring match across `name` and `description` (case-insensitive). */
  text?: string;
}
