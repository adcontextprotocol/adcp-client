/**
 * Default factory for `comply_test_controller` stores.
 *
 * Most sellers implementing conformance wire ~300 lines of boilerplate against
 * their own session state: a Map per status kind, a Map per seed kind, matching
 * force/simulate/seed handlers, cap enforcement, and idempotent save calls.
 * {@link createDefaultTestControllerStore} collapses that to ten lines by
 * wiring every scenario against a generic {@link DefaultSessionShape} — the
 * seller brings `loadSession` / `saveSession`, the factory hands back a
 * conformance-ready {@link TestControllerStore}.
 *
 * @example Postgres-backed seller
 * ```ts
 * import { createAdcpServer, serve } from '@adcp/client/server';
 * import {
 *   createDefaultTestControllerStore,
 *   createDefaultSession,
 *   registerTestController,
 * } from '@adcp/client/testing';
 *
 * const controller = createDefaultTestControllerStore({
 *   async loadSession({ context }) {
 *     const sessionId = (context as { session_id?: string })?.session_id ?? 'anon';
 *     const row = await db.query('select state from comply_sessions where id=$1', [sessionId]);
 *     return row ? deserializeSession(row.state) : createDefaultSession();
 *   },
 *   async saveSession(session) {
 *     await db.query(
 *       'insert into comply_sessions(id,state) values($1,$2) on conflict (id) do update set state=$2',
 *       [session.sessionId, serializeSession(session)]
 *     );
 *   },
 * });
 *
 * const server = createAdcpServer({ name: 'my-seller', version: '1.0.0' });
 * registerTestController(server, controller);
 * serve(server, { port: 3000 });
 * ```
 *
 * @example Partial overrides
 *
 * Sellers who want most defaults but need custom behavior for one scenario
 * pass `overrides`. The override wins for that scenario; every other scenario
 * still uses the default handler.
 *
 * ```ts
 * const controller = createDefaultTestControllerStore({
 *   loadSession,
 *   saveSession,
 *   overrides: {
 *     async forceMediaBuyStatus(mediaBuyId, status, rejectionReason) {
 *       // Seller's production state machine — controller routes through it.
 *       return await mediaBuys.transition(mediaBuyId, status, rejectionReason);
 *     },
 *   },
 * });
 * ```
 */

import type {
  TestControllerStore,
  TestControllerStoreFactory,
  ControllerScenario,
} from '../server/test-controller';
import {
  CONTROLLER_SCENARIOS,
  SESSION_ENTRY_CAP,
  TestControllerError,
  enforceMapCap,
} from '../server/test-controller';
import type { AccountStatus, CreativeStatus, MediaBuyStatus } from '../types/core.generated';
import type { SimulationSuccess, StateTransitionSuccess } from '../types/tools.generated';

// ────────────────────────────────────────────────────────────
// Session shape
// ────────────────────────────────────────────────────────────

/** Session-scoped state for a force_session_status entity. */
export type SessionTerminalStatus = 'complete' | 'terminated';

/** Stored payload for `simulate_delivery`. The latest call wins; cumulative
 * totals are computed from the history below. */
export interface DeliverySimulationRecord {
  impressions?: number;
  clicks?: number;
  conversions?: number;
  reported_spend?: { amount: number; currency: string };
}

/** Stored payload for `simulate_budget_spend`. One record per
 * account_id / media_buy_id (whichever key was supplied). */
export interface BudgetSpendRecord {
  account_id?: string;
  media_buy_id?: string;
  spend_percentage: number;
}

/** Seed payloads are stored verbatim so downstream handlers (get_products,
 * sync_creatives, etc.) can read them. Wiring the seeded payload into those
 * production tools is the seller's responsibility — see the per-Map comments
 * below for how to reach each payload. */
export type SeedFixture = Record<string, unknown>;

/**
 * The default session shape. Every scenario's default handler reads/writes one
 * of these Maps. Sellers bringing their own session type should structurally
 * match this interface — additional fields are allowed and ignored by the
 * default factory.
 */
export interface DefaultSessionShape {
  /** Current status per account_id. Missing keys are treated as `'active'`
   * on first force — accounts have no seed_* scenario, so upsert is the only
   * sensible default. */
  accountStatuses: Map<string, AccountStatus>;

  /** Current status per creative_id. A force_creative_status call on a key
   * not present here AND not present in {@link seededCreatives} raises
   * NOT_FOUND — seed first, then force. */
  creativeStatuses: Map<string, CreativeStatus>;

  /** Optional rejection_reason paired with creativeStatuses. Only set when
   * the last transition was to `'rejected'`. */
  creativeRejectionReasons: Map<string, string>;

  /** Current status per media_buy_id. A force_media_buy_status call on a key
   * not present here AND not present in {@link seededMediaBuys} raises
   * NOT_FOUND — seed first, then force. */
  mediaBuyStatuses: Map<string, MediaBuyStatus>;

  /** Optional rejection_reason paired with mediaBuyStatuses. */
  mediaBuyRejectionReasons: Map<string, string>;

  /** Terminal session state per session_id. Missing keys are treated as
   * `'active'` on first force — sessions have no seed_* scenario. */
  sessionStatuses: Map<string, SessionTerminalStatus>;

  /** Optional termination_reason paired with sessionStatuses. */
  sessionTerminationReasons: Map<string, string>;

  /** Latest simulate_delivery payload per media_buy_id. */
  simulatedDeliveries: Map<string, DeliverySimulationRecord>;

  /** Cumulative simulate_delivery totals per media_buy_id. Updated on every
   * simulate_delivery call by summing the delta from the latest record. */
  cumulativeDeliveries: Map<string, DeliverySimulationRecord>;

  /** Latest simulate_budget_spend payload per entity. Key is
   * `account_id` or `media_buy_id` prefixed with `account:` / `media_buy:`
   * to avoid collisions when both spaces share an id. */
  simulatedBudgetSpends: Map<string, BudgetSpendRecord>;

  /** Seeded product fixtures, keyed by product_id. Consume via
   * `session.seededProducts.get(id)` from your `get_products` handler. */
  seededProducts: Map<string, SeedFixture>;

  /** Seeded pricing-option fixtures, keyed by `${product_id}:${pricing_option_id}`. */
  seededPricingOptions: Map<string, SeedFixture>;

  /** Seeded creative fixtures, keyed by creative_id. Consume via
   * `session.seededCreatives.get(id)` from your `sync_creatives` or
   * `list_creatives` handler. */
  seededCreatives: Map<string, SeedFixture>;

  /** Seeded plan fixtures, keyed by plan_id. Consume via
   * `session.seededPlans.get(id)` from your `get_plan` handler. */
  seededPlans: Map<string, SeedFixture>;

  /** Seeded media-buy fixtures, keyed by media_buy_id. Consume via
   * `session.seededMediaBuys.get(id)` from your `get_media_buy` handler. */
  seededMediaBuys: Map<string, SeedFixture>;
}

/** Build a fresh {@link DefaultSessionShape} with empty Maps for every field.
 * Convenient for sellers starting from nothing or for test fixtures. */
export function createDefaultSession(): DefaultSessionShape {
  return {
    accountStatuses: new Map(),
    creativeStatuses: new Map(),
    creativeRejectionReasons: new Map(),
    mediaBuyStatuses: new Map(),
    mediaBuyRejectionReasons: new Map(),
    sessionStatuses: new Map(),
    sessionTerminationReasons: new Map(),
    simulatedDeliveries: new Map(),
    cumulativeDeliveries: new Map(),
    simulatedBudgetSpends: new Map(),
    seededProducts: new Map(),
    seededPricingOptions: new Map(),
    seededCreatives: new Map(),
    seededPlans: new Map(),
    seededMediaBuys: new Map(),
  };
}

// ────────────────────────────────────────────────────────────
// Factory options
// ────────────────────────────────────────────────────────────

/** Input passed to {@link CreateDefaultTestControllerStoreOptions.loadSession}. */
export interface DefaultLoadSessionInput {
  /** The raw AdCP `context` object from the `comply_test_controller` request.
   * Typically used to extract `session_id` for tenant-scoped persistence. */
  context: unknown;
}

export interface CreateDefaultTestControllerStoreOptions<S extends DefaultSessionShape> {
  /** Called per request to load session state. Return a fresh session for
   * first-seen keys (see {@link createDefaultSession}); otherwise rehydrate
   * from your persistence layer. */
  loadSession: (input: DefaultLoadSessionInput) => Promise<S>;

  /** Called after each mutation to persist. Omit for in-memory scenarios
   * where `loadSession` returns a reference to a long-lived object that the
   * handler mutates in place. */
  saveSession?: (session: S) => Promise<void>;

  /** Per-Map cap. Any `.set()` that would push a Map above this cap raises
   * `INVALID_STATE` via {@link enforceMapCap}. Defaults to
   * {@link SESSION_ENTRY_CAP} (1000). */
  mapCap?: number;

  /** Override any default handler. An override REPLACES the default for that
   * scenario — partial overrides are supported and the remaining scenarios
   * keep the factory's defaults. */
  overrides?: Partial<TestControllerStore>;
}

// ────────────────────────────────────────────────────────────
// Default handler helpers
// ────────────────────────────────────────────────────────────

const ACCOUNT_STATUS_DEFAULT: AccountStatus = 'active';
const CREATIVE_STATUS_DEFAULT: CreativeStatus = 'processing';
const MEDIA_BUY_STATUS_DEFAULT: MediaBuyStatus = 'pending_creatives';
const SESSION_STATUS_DEFAULT = 'active' as const;

function budgetSpendKey(record: BudgetSpendRecord): string {
  if (record.media_buy_id) return `media_buy:${record.media_buy_id}`;
  if (record.account_id) return `account:${record.account_id}`;
  // Dispatcher already rejects requests that supply neither, so this branch
  // is unreachable from the wire. Fail loudly if a seller calls the handler
  // directly without either id — silent bucketing would corrupt cumulative
  // totals.
  throw new TestControllerError(
    'INVALID_PARAMS',
    'simulate_budget_spend requires params.account_id or params.media_buy_id'
  );
}

function addDelivery(
  running: DeliverySimulationRecord | undefined,
  delta: DeliverySimulationRecord
): DeliverySimulationRecord {
  const base = running ?? {};
  const merged: DeliverySimulationRecord = {};
  if (base.impressions !== undefined || delta.impressions !== undefined) {
    merged.impressions = (base.impressions ?? 0) + (delta.impressions ?? 0);
  }
  if (base.clicks !== undefined || delta.clicks !== undefined) {
    merged.clicks = (base.clicks ?? 0) + (delta.clicks ?? 0);
  }
  if (base.conversions !== undefined || delta.conversions !== undefined) {
    merged.conversions = (base.conversions ?? 0) + (delta.conversions ?? 0);
  }
  // reported_spend: sum amounts when currencies match. Differing currencies is
  // a seller-side modeling error; keep the latest and let the caller notice.
  if (delta.reported_spend) {
    if (base.reported_spend && base.reported_spend.currency === delta.reported_spend.currency) {
      merged.reported_spend = {
        amount: base.reported_spend.amount + delta.reported_spend.amount,
        currency: delta.reported_spend.currency,
      };
    } else {
      merged.reported_spend = { ...delta.reported_spend };
    }
  } else if (base.reported_spend) {
    merged.reported_spend = { ...base.reported_spend };
  }
  return merged;
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

/** Factory return type — the shape `registerTestController` expects when the
 * seller wants list_scenarios answered without invoking the loader. */
export interface DefaultTestControllerStoreResult extends TestControllerStoreFactory {
  /** Advertised scenarios — the six force_* / simulate_* entries. Seeds are
   * not advertised per spec, but the store still handles them. */
  readonly scenarios: readonly ControllerScenario[];

  /** Build a store bound to the current request. Invoked by the dispatcher
   * for every non-`list_scenarios` request. */
  createStore(input: Record<string, unknown>): Promise<TestControllerStore>;
}

/** All advertised scenarios — every entry in {@link CONTROLLER_SCENARIOS}.
 * The default factory implements all of them; seeds are handled too but not
 * listed here (they aren't advertised via list_scenarios per spec). */
const ALL_ADVERTISED_SCENARIOS: readonly ControllerScenario[] = Object.freeze([
  CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS,
  CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS,
  CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS,
  CONTROLLER_SCENARIOS.FORCE_SESSION_STATUS,
  CONTROLLER_SCENARIOS.SIMULATE_DELIVERY,
  CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND,
]);

/**
 * Build a factory-shaped {@link TestControllerStoreFactory} with default
 * handlers for every `force_*`, `simulate_*`, and `seed_*` scenario, each
 * operating on a {@link DefaultSessionShape}.
 *
 * Pass the result straight to `registerTestController(server, result)`.
 */
export function createDefaultTestControllerStore<S extends DefaultSessionShape>(
  opts: CreateDefaultTestControllerStoreOptions<S>
): DefaultTestControllerStoreResult {
  const cap = opts.mapCap ?? SESSION_ENTRY_CAP;
  const { loadSession, saveSession, overrides } = opts;

  async function persist(session: S): Promise<void> {
    if (saveSession) await saveSession(session);
  }

  async function buildStore(input: Record<string, unknown>): Promise<TestControllerStore> {
    const context = (input.context as unknown) ?? undefined;
    const session = await loadSession({ context });

    const defaults: TestControllerStore = {
      // ── force_creative_status ─────────────────────────────
      async forceCreativeStatus(
        creativeId,
        status,
        rejectionReason
      ): Promise<StateTransitionSuccess> {
        const tracked = session.creativeStatuses.get(creativeId);
        const seeded = session.seededCreatives.get(creativeId);
        if (tracked === undefined && seeded === undefined) {
          throw new TestControllerError(
            'NOT_FOUND',
            `Creative ${creativeId} not found. Seed it first with seed_creative.`
          );
        }
        const previous =
          tracked ?? ((seeded?.status as CreativeStatus | undefined) ?? CREATIVE_STATUS_DEFAULT);
        enforceMapCap(session.creativeStatuses, creativeId, 'creative statuses', cap);
        session.creativeStatuses.set(creativeId, status);
        if (status === 'rejected' && rejectionReason) {
          enforceMapCap(
            session.creativeRejectionReasons,
            creativeId,
            'creative rejection reasons',
            cap
          );
          session.creativeRejectionReasons.set(creativeId, rejectionReason);
        } else {
          session.creativeRejectionReasons.delete(creativeId);
        }
        await persist(session);
        return { success: true, previous_state: previous, current_state: status };
      },

      // ── force_account_status ──────────────────────────────
      async forceAccountStatus(accountId, status): Promise<StateTransitionSuccess> {
        // Accounts have no seed; upsert with 'active' default so storyboards
        // can transition accounts without a prior setup step.
        const previous = session.accountStatuses.get(accountId) ?? ACCOUNT_STATUS_DEFAULT;
        enforceMapCap(session.accountStatuses, accountId, 'account statuses', cap);
        session.accountStatuses.set(accountId, status);
        await persist(session);
        return { success: true, previous_state: previous, current_state: status };
      },

      // ── force_media_buy_status ────────────────────────────
      async forceMediaBuyStatus(
        mediaBuyId,
        status,
        rejectionReason
      ): Promise<StateTransitionSuccess> {
        const tracked = session.mediaBuyStatuses.get(mediaBuyId);
        const seeded = session.seededMediaBuys.get(mediaBuyId);
        if (tracked === undefined && seeded === undefined) {
          throw new TestControllerError(
            'NOT_FOUND',
            `Media buy ${mediaBuyId} not found. Seed it first with seed_media_buy.`
          );
        }
        const previous =
          tracked ?? ((seeded?.status as MediaBuyStatus | undefined) ?? MEDIA_BUY_STATUS_DEFAULT);
        enforceMapCap(session.mediaBuyStatuses, mediaBuyId, 'media buy statuses', cap);
        session.mediaBuyStatuses.set(mediaBuyId, status);
        if (rejectionReason) {
          enforceMapCap(
            session.mediaBuyRejectionReasons,
            mediaBuyId,
            'media buy rejection reasons',
            cap
          );
          session.mediaBuyRejectionReasons.set(mediaBuyId, rejectionReason);
        } else {
          session.mediaBuyRejectionReasons.delete(mediaBuyId);
        }
        await persist(session);
        return { success: true, previous_state: previous, current_state: status };
      },

      // ── force_session_status ──────────────────────────────
      async forceSessionStatus(
        sessionId,
        status,
        terminationReason
      ): Promise<StateTransitionSuccess> {
        // SI sessions have no seed; upsert with 'active' default.
        const previous = session.sessionStatuses.get(sessionId) ?? SESSION_STATUS_DEFAULT;
        enforceMapCap(session.sessionStatuses, sessionId, 'session statuses', cap);
        session.sessionStatuses.set(sessionId, status);
        if (terminationReason) {
          enforceMapCap(
            session.sessionTerminationReasons,
            sessionId,
            'session termination reasons',
            cap
          );
          session.sessionTerminationReasons.set(sessionId, terminationReason);
        } else {
          session.sessionTerminationReasons.delete(sessionId);
        }
        await persist(session);
        return { success: true, previous_state: previous, current_state: status };
      },

      // ── simulate_delivery ─────────────────────────────────
      async simulateDelivery(mediaBuyId, params): Promise<SimulationSuccess> {
        const delta: DeliverySimulationRecord = {
          impressions: params.impressions,
          clicks: params.clicks,
          conversions: params.conversions,
          reported_spend: params.reported_spend,
        };
        enforceMapCap(session.simulatedDeliveries, mediaBuyId, 'simulated deliveries', cap);
        session.simulatedDeliveries.set(mediaBuyId, delta);
        enforceMapCap(session.cumulativeDeliveries, mediaBuyId, 'cumulative deliveries', cap);
        const cumulative = addDelivery(session.cumulativeDeliveries.get(mediaBuyId), delta);
        session.cumulativeDeliveries.set(mediaBuyId, cumulative);
        await persist(session);
        return {
          success: true,
          simulated: { ...delta } as SimulationSuccess['simulated'],
          cumulative: { ...cumulative } as SimulationSuccess['cumulative'],
        };
      },

      // ── simulate_budget_spend ─────────────────────────────
      async simulateBudgetSpend(params): Promise<SimulationSuccess> {
        const record: BudgetSpendRecord = {
          account_id: params.account_id,
          media_buy_id: params.media_buy_id,
          spend_percentage: params.spend_percentage,
        };
        const key = budgetSpendKey(record);
        enforceMapCap(session.simulatedBudgetSpends, key, 'simulated budget spends', cap);
        session.simulatedBudgetSpends.set(key, record);
        await persist(session);
        return {
          success: true,
          simulated: {
            spend_percentage: record.spend_percentage,
          } as SimulationSuccess['simulated'],
        };
      },

      // ── seed_product ──────────────────────────────────────
      // NOTE: wiring seeded fixtures into `get_products` is the seller's
      // responsibility and is intentionally NOT done here. The seeded
      // payload is stored verbatim on `session.seededProducts` — consume it
      // from your production handler via `session.seededProducts.get(id)`.
      async seedProduct(productId, fixture): Promise<void> {
        enforceMapCap(session.seededProducts, productId, 'seeded products', cap);
        session.seededProducts.set(productId, fixture ?? {});
        await persist(session);
      },

      // ── seed_pricing_option ───────────────────────────────
      async seedPricingOption(productId, pricingOptionId, fixture): Promise<void> {
        const key = `${productId}:${pricingOptionId}`;
        enforceMapCap(session.seededPricingOptions, key, 'seeded pricing options', cap);
        session.seededPricingOptions.set(key, fixture ?? {});
        await persist(session);
      },

      // ── seed_creative ─────────────────────────────────────
      // Consume `session.seededCreatives` from your `sync_creatives` /
      // `list_creatives` handler to satisfy storyboard steps that reference
      // the seeded id.
      async seedCreative(creativeId, fixture): Promise<void> {
        enforceMapCap(session.seededCreatives, creativeId, 'seeded creatives', cap);
        session.seededCreatives.set(creativeId, fixture ?? {});
        await persist(session);
      },

      // ── seed_plan ─────────────────────────────────────────
      async seedPlan(planId, fixture): Promise<void> {
        enforceMapCap(session.seededPlans, planId, 'seeded plans', cap);
        session.seededPlans.set(planId, fixture ?? {});
        await persist(session);
      },

      // ── seed_media_buy ────────────────────────────────────
      // Consume `session.seededMediaBuys` from your `get_media_buy` /
      // delivery handlers so storyboard steps can reference the seeded id.
      async seedMediaBuy(mediaBuyId, fixture): Promise<void> {
        enforceMapCap(session.seededMediaBuys, mediaBuyId, 'seeded media buys', cap);
        session.seededMediaBuys.set(mediaBuyId, fixture ?? {});
        await persist(session);
      },
    };

    if (overrides) {
      // Apply overrides: a provided method REPLACES the default for that key.
      // `undefined` entries suppress a default so the dispatcher returns
      // UNKNOWN_SCENARIO for that scenario.
      for (const key of Object.keys(overrides) as Array<keyof TestControllerStore>) {
        const override = overrides[key];
        if (override === undefined) {
          delete defaults[key];
        } else {
          (defaults as Record<string, unknown>)[key] = override;
        }
      }
    }

    return defaults;
  }

  return {
    scenarios: ALL_ADVERTISED_SCENARIOS,
    createStore: buildStore,
  };
}
