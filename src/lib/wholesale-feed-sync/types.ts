import type { SingleAgentClient } from '../core/SingleAgentClient';
import type * as V31Beta from '../types/v3-1-beta';

/**
 * Operating mode for a {@link WholesaleFeedSync} instance, resolved from the
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
 * The top-level `sync.mode` is the lowest mode across the two entity
 * tracks — `sync.products.mode` and `sync.signals.mode` can differ
 * when the agent declares per-entity capability vectors (e.g., products
 * feed supported but signals wholesale only).
 */
export type WholesaleFeedSyncMode = 'manual' | 'auto-poll';

/**
 * Lifecycle state of the sync engine.
 */
export type WholesaleFeedSyncState = 'idle' | 'bootstrapping' | 'syncing' | 'error';

/**
 * Subset of `SingleAgentClient` that {@link WholesaleFeedSync} actually uses.
 * Lets tests inject a minimal stub without constructing a full client.
 */
export interface WholesaleFeedSyncClient {
  getAdcpCapabilities: SingleAgentClient['getAdcpCapabilities'];
  getProducts: SingleAgentClient['getProducts'];
  getSignals: SingleAgentClient['getSignals'];
}

/**
 * Configuration for a {@link WholesaleFeedSync} instance.
 *
 * The SDK's primary version pin (`ADCP_VERSION`) stays at GA; the wholesale
 * feed surfaces activate when the agent declares `wholesale_feed_versioning`
 * and/or `wholesale_feed_webhooks` in its `get_adcp_capabilities` response.
 * Against pre-3.1 agents the sync still works in `'manual'` mode — bootstrap
 * via wholesale, no background sync.
 */
export interface WholesaleFeedSyncConfig {
  /** Pre-configured client (or stub) for tool calls against the target agent. */
  client: WholesaleFeedSyncClient;

  /**
   * Account scope for wholesale product/signal reads. Beta 3 wholesale-feed
   * webhooks are account-anchored; pass the same account used when registering
   * `notification_configs[]` so repair reads reconcile the correct public or
   * account overlay.
   */
  account?: V31Beta.AccountReference;

  /**
   * Expected inbound webhook subscription scope. Set this when routing a
   * validated webhook receiver into a WholesaleFeedSync instance so misrouted
   * account/subscriber fires are rejected before mutating the mirror.
   */
  webhookScope?: {
    /** Authenticated sender identity, used only to scope idempotency keys. */
    senderId?: string;
    /** Seller account_id expected on wholesale-feed webhook envelopes. */
    accountId?: string;
    /** Optional expected notification_configs[].subscriber_id. */
    subscriberId?: string;
  };

  /**
   * Optional durable dedupe store. Receivers handling webhooks across process
   * restarts should persist these keys; the SDK also keeps a best-effort
   * in-memory set for single-process duplicate suppression.
   */
  webhookDedupStore?: {
    has(key: string): boolean | Promise<boolean>;
    add(key: string): void | Promise<void>;
  };

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

  /** Error callback for background poll/probe failures. */
  onError?: (error: Error) => void;
}

/**
 * The resolved capability vector after `start()` probes the agent.
 * Snapshot at probe time; if the agent's capabilities change, the SDK
 * re-resolves on the next `capabilityRefreshIntervalMs` tick.
 */
export interface ResolvedCapabilities {
  /** Whether the agent supports `if_wholesale_feed_version` conditional fetch. */
  wholesaleFeedVersioning: boolean;
  /** Whether the agent supports webhook subscriptions on the feed. */
  webhooks: boolean;
  /** Event types the agent advertises for account-level wholesale feed webhooks. */
  eventTypes: readonly string[];
}

/**
 * EventEmitter contract. Wholesale feed events fire per-type so callers
 * can `sync.on('product.priced', ...)` without filtering. The wildcard
 * `'event'` channel emits every feed change for callers that want a
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
 * - `stateChange` — fires on every {@link WholesaleFeedSyncState} transition.
 */
export interface WholesaleFeedSyncEvents {
  bootstrap: [{ productCount: number; signalCount: number; mode: WholesaleFeedSyncMode }];
  sync: [{ eventsApplied: number }];
  mode_resolved: [{ mode: WholesaleFeedSyncMode; capabilities: ResolvedCapabilities }];
  resyncing: [{ reason: 'bulk_change' | 'version_mismatch' | 'manual' }];
  error: [{ error: Error }];
  stateChange: [{ from: WholesaleFeedSyncState; to: WholesaleFeedSyncState }];
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
 * Client-side filter for {@link WholesaleFeedSync.products.search}.
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
 * Client-side filter for {@link WholesaleFeedSync.signals.search}. Same
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
