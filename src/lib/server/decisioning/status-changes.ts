/**
 * Status-change event bus for the v6.0 decisioning runtime.
 *
 * Adopters call `publishStatusChange(...)` from anywhere — webhook handler,
 * cron, in-process worker, the body of a `*Task` method — to push lifecycle
 * updates on a resource the framework knows about. The framework records
 * the change against the resource and projects it to subscribed buyers via
 * the MCP Resources subscription extension (`notifications/resources/updated`)
 * and the equivalent A2A DataPart-typed message contract.
 *
 * Ten resource types are wired in v6.0 (matches AdCP 3.0 lifecycle
 * channels):
 *
 *   - `media_buy`      — pending → active → completed; paused, canceled
 *   - `creative`       — pending_review → approved/rejected
 *   - `audience`       — matching → matched → activating → active
 *   - `signal`         — pending → activated → expired
 *   - `proposal`       — issued → accepted/expired/withdrawn
 *   - `plan`           — draft → submitted → approved/rejected
 *   - `rights_grant`   — pending → granted/denied/expired
 *   - `delivery_report`— staging → published (manual report-runs)
 *   - `property_list`  — list-changed events (cache invalidation, fetch_token revoke)
 *   - `collection_list`— list-changed events (cache invalidation, fetch_token revoke)
 *
 * The bus is module-level so adopters can call `publishStatusChange(...)`
 * without holding a reference to the server. The framework wires the bus
 * into the server's resource registry at construction; in tests, the
 * registry can be swapped via `setStatusChangeBus(...)`.
 *
 * Status: Preview / 6.0. Wire-level MCP Resources subscription handlers
 * and the A2A backport land in a subsequent commit; this file ships the
 * adopter-facing primitive and an in-memory subscriber model the runtime
 * can consume.
 *
 * @public
 */

export type StatusChangeResourceType =
  | 'media_buy'
  | 'creative'
  | 'audience'
  | 'signal'
  | 'proposal'
  | 'plan'
  | 'rights_grant'
  | 'delivery_report'
  | 'property_list'
  | 'collection_list';

/**
 * A single status-change event.
 *
 * `account_id` scopes the event to a tenant; subscribers receive only
 * events for their resolved account. `resource_uri` follows the MCP
 * Resources URI scheme: `adcp://{account_id}/{resource_type}/{resource_id}`.
 */
export interface StatusChange<TPayload = unknown> {
  account_id: string;
  resource_type: StatusChangeResourceType;
  resource_id: string;
  /** Canonical MCP Resources URI for this resource. */
  resource_uri: string;
  /** ISO 8601 timestamp the change was observed. */
  at: string;
  /**
   * Resource-type-specific change payload. Shape is the wire fragment the
   * subscribed buyer will see — e.g., for `media_buy` it's the AdCP
   * `media_buy_status_changes` message body.
   */
  payload: TPayload;
  /**
   * Correlation id linking this change back to the buyer request that
   * caused it. Useful for "show me everything that happened from this
   * `create_media_buy` call" observability across HITL flows. Adopters
   * pass through `ctx.task.id` (for `*Task`-driven changes) or any
   * stable request identifier they generate at dispatch time.
   *
   * Optional — many status changes originate from cron / webhook /
   * upstream-platform events that have no buyer-request correlation.
   */
  caused_by_request_id?: string;
  /**
   * Status the resource was transitioning FROM. Lets subscribers assert
   * legal transitions (`from: 'matching' → to: 'active'` is fine;
   * `from: 'failed' → to: 'matching'` is a state-machine bug). The
   * framework doesn't validate transitions in v6.0 (no per-resource
   * state machine yet); the field is captured and projected to the
   * wire so downstream consumers can.
   */
  previous_status?: string;
}

export interface PublishStatusChangeOpts<TPayload = unknown> {
  account_id: string;
  resource_type: StatusChangeResourceType;
  resource_id: string;
  payload: TPayload;
  /** Override the timestamp (defaults to now). Useful for replay/backfill. */
  at?: string;
  /**
   * Correlation id linking this change to the buyer request that caused
   * it. Inside `*Task` method bodies, pass `ctx.task.id` to thread the
   * task lifecycle. Outside HITL flows, pass any stable request id you
   * derive at dispatch time. Optional.
   */
  caused_by_request_id?: string;
  /** Status the resource was transitioning FROM. Optional. */
  previous_status?: string;
}

export type StatusChangeListener = (event: StatusChange) => void | Promise<void>;

export interface StatusChangeBus {
  publish<TPayload>(opts: PublishStatusChangeOpts<TPayload>): void;
  /**
   * Subscribe a listener. Returns an unsubscribe function. Listeners are
   * fire-and-forget; rejected promises are caught and logged so one bad
   * subscriber doesn't break delivery to others.
   */
  subscribe(listener: StatusChangeListener): () => void;
  /** Snapshot the most-recent N events (in-memory cache for `tasks/get` + replay). */
  recent(limit?: number): readonly StatusChange[];
}

const DEFAULT_RECENT_LIMIT = 1000;

export function createInMemoryStatusChangeBus(opts?: { recentLimit?: number }): StatusChangeBus {
  const listeners = new Set<StatusChangeListener>();
  const recent: StatusChange[] = [];
  const recentLimit = opts?.recentLimit ?? DEFAULT_RECENT_LIMIT;

  return {
    publish<TPayload>(eventOpts: PublishStatusChangeOpts<TPayload>): void {
      const event: StatusChange<TPayload> = {
        account_id: eventOpts.account_id,
        resource_type: eventOpts.resource_type,
        resource_id: eventOpts.resource_id,
        resource_uri: `adcp://${eventOpts.account_id}/${eventOpts.resource_type}/${eventOpts.resource_id}`,
        at: eventOpts.at ?? new Date().toISOString(),
        payload: eventOpts.payload,
        ...(eventOpts.caused_by_request_id !== undefined && { caused_by_request_id: eventOpts.caused_by_request_id }),
        ...(eventOpts.previous_status !== undefined && { previous_status: eventOpts.previous_status }),
      };
      recent.push(event as StatusChange);
      if (recent.length > recentLimit) recent.shift();

      for (const listener of listeners) {
        try {
          const result = listener(event as StatusChange);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[adcp] status-change listener rejected:', err);
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[adcp] status-change listener threw:', err);
        }
      }
    },

    subscribe(listener: StatusChangeListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    recent(limit?: number): readonly StatusChange[] {
      const n = limit ?? recent.length;
      return recent.slice(-n);
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level adopter-facing primitive
// ---------------------------------------------------------------------------

let activeBus: StatusChangeBus = createInMemoryStatusChangeBus();

/**
 * Push a status change for a resource. Adopters call this from anywhere —
 * webhook handler, cron, in-process worker — to surface lifecycle changes
 * the framework projects to subscribed buyers.
 *
 * ```ts
 * // After GAM webhook reports order activation:
 * publishStatusChange({
 *   account_id: account.id,
 *   resource_type: 'media_buy',
 *   resource_id: gamOrderToBuyId(order),
 *   payload: { status: 'active', activated_at: order.startTime },
 * });
 * ```
 *
 * Buyers subscribed via MCP `resources/subscribe` (or the A2A equivalent)
 * receive the change as a `notifications/resources/updated` notification
 * carrying the `payload` as the resource's wire fragment.
 */
export function publishStatusChange<TPayload>(opts: PublishStatusChangeOpts<TPayload>): void {
  activeBus.publish(opts);
}

/**
 * Replace the active bus. The framework calls this at server construction
 * to wire its own bus implementation; tests can call it to swap in a fake.
 *
 * Returns the previous bus so the caller can restore it (e.g., in a test
 * teardown).
 */
export function setStatusChangeBus(bus: StatusChangeBus): StatusChangeBus {
  const prev = activeBus;
  activeBus = bus;
  return prev;
}

/** Read the active bus (for the framework to wire subscribers). */
export function getStatusChangeBus(): StatusChangeBus {
  return activeBus;
}
