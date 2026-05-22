import type { SingleAgentClient } from '../core/SingleAgentClient';
import type * as V31Beta from '../types/v3-1-beta';

/**
 * Operating mode for a {@link CatalogSync} instance, resolved from the
 * agent's capability stanza at `start()` time.
 *
 * - `'auto-poll'` — agent declares `wholesale_feed_versioning.supported: true`
 *   but no change feed. Bootstrap via wholesale, then re-probe with
 *   `if_wholesale_feed_version` at `probeIntervalMs`. On version change,
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
export type CatalogSyncMode = 'manual' | 'auto-poll';

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
 * sync surfaces activate when the agent declares `wholesale_feed_versioning`
 * and/or `wholesale_feed_webhooks` in its `get_adcp_capabilities` response.
 * Against pre-3.1 agents the sync still works in `'manual'` mode — bootstrap
 * via wholesale, no background sync.
 */
export interface CatalogSyncConfig {
  /** Pre-configured client (or stub) for tool calls against the target agent. */
  client: CatalogSyncClient;

  /**
   * @deprecated Beta 3 removed the public `/catalog/events` polling feed.
   * Register account-level `notification_configs[]` via `sync_accounts`,
   * deliver inbound webhook payloads to `applyWebhook()`, and use
   * conditional wholesale reads for repair/reconciliation.
   */
  feedOrigin?: string;

  /** @deprecated No-op after beta 3; direct feed polling was removed. */
  feedHeaders?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /** @deprecated No-op after beta 3; direct feed polling was removed. */
  maxFeedResponseBytes?: number;

  /** @deprecated No-op after beta 3; inbound webhooks are pushed by the seller. */
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
   * detect a mode upgrade (e.g., manual → auto-poll as the agent
   * adopts new spec surfaces). Default: 86_400_000 (24h). Set to 0 to
   * disable.
   */
  capabilityRefreshIntervalMs?: number;

  /** @deprecated No-op after beta 3; direct feed cursors were removed. */
  cursorStore?: unknown;

  /** Error callback for background poll/probe failures. */
  onError?: (error: Error) => void;

  /** @deprecated No-op after beta 3; direct feed polling was removed. */
  fetch?: typeof fetch;
}

/**
 * The resolved capability vector after `start()` probes the agent.
 * Snapshot at probe time; if the agent's capabilities change, the SDK
 * re-resolves on the next `capabilityRefreshIntervalMs` tick.
 */
export interface ResolvedCapabilities {
  /** Whether the agent supports `if_wholesale_feed_version` conditional fetch. */
  wholesaleFeedVersioning: boolean;
  /** @deprecated Use `wholesaleFeedVersioning`. */
  catalogVersioning: boolean;
  /** Whether the agent supports webhook subscriptions on the feed. */
  webhooks: boolean;
  /** Event types the agent advertises for account-level wholesale feed webhooks. */
  eventTypes: readonly string[];
}

/**
 * EventEmitter contract. Catalog change events fire per-type so callers
 * can `catalog.on('product.priced', ...)` without filtering. The wildcard
 * `'event'` channel emits every catalog change for callers that want a
 * single sink (audit logs, downstream queues).
 *
 * **Authoritative vs synthetic events.** Events delivered through
 * `applyWebhook()` are AUTHORITATIVE — they carry the seller's `event_id`
 * and the documented `applies_to` cache scope. Events
 * emitted during `refresh()` / `'auto-poll'` mode are SYNTHESIZED by
 * the SDK from a diff of previous-vs-fresh state; they carry locally
 * generated event IDs (NOT v7) and `synthetic: true` on the emit
 * envelope. Adopters writing event_ids to a dedupe table MUST check
 * `synthetic` before storing — synthetic IDs collide across instances
 * and don't satisfy the seller-authored event identity invariant.
 *
 * Lifecycle events:
 * - `bootstrap` — initial sync completed; replica is current.
 * - `sync` — inbound webhook applied OR diff cycle completed
 *   (`'auto-poll'` / `'manual'` after `refresh()`).
 * - `mode_resolved` — emitted on `start()` after the capability probe
 *   picks a mode. Useful for UI mode badges.
 * - `resyncing` — emitted before a `wholesale_feed.bulk_change` recovery
 *   re-bootstrap, webhook-version mismatch repair, or manual refresh.
 * - `error` — background poll/probe error. Non-fatal; sync stays in
 *   `'syncing'` and retries on the next tick.
 * - `stateChange` — fires on every {@link CatalogSyncState} transition.
 */
export interface CatalogSyncEvents {
  bootstrap: [{ productCount: number; signalCount: number; mode: CatalogSyncMode }];
  sync: [{ eventsApplied: number }];
  mode_resolved: [{ mode: CatalogSyncMode; capabilities: ResolvedCapabilities }];
  resyncing: [{ reason: 'bulk_change' | 'version_mismatch' | 'manual' }];
  error: [{ error: Error }];
  stateChange: [{ from: CatalogSyncState; to: CatalogSyncState }];
  // Per-event-type fan-outs. Payload is the full WholesaleFeedEvent so callers
  // can read `event_id`, `created_at`, and the discriminated `payload`.
  // `synthetic: true` flags events emitted from refresh() or auto-poll
  // diff computation (not from the agent's feed).
  event: [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'product.created': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'product.updated': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'product.priced': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'product.removed': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'signal.created': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'signal.updated': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'signal.priced': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'signal.removed': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
  'wholesale_feed.bulk_change': [{ event: V31Beta.WholesaleFeedEvent; synthetic?: boolean }];
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
