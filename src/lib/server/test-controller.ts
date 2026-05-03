/**
 * Server-side comply_test_controller implementation.
 *
 * Most new code should use {@link createComplyController} from
 * `@adcp/sdk/testing` — it wraps this module with a domain-grouped
 * (`seed` / `force` / `simulate`) adapter surface, typed params, sandbox
 * gating, and built-in seed idempotency. The functions below remain
 * supported for existing integrations and for custom wrappers that need
 * access to the underlying request handler / MCP envelope helpers.
 *
 * Sellers typically call `registerTestController(server, store)` to add the
 * `comply_test_controller` tool to their MCP server. The TestControllerStore
 * interface lets sellers wire up their own state management while the SDK
 * handles request parsing, scenario dispatch, and response formatting.
 *
 * @example Basic usage — single in-memory store
 * ```typescript
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { registerTestController, TestControllerError } from '@adcp/sdk';
 *
 * const accounts = new Map<string, string>();
 *
 * registerTestController(server, {
 *   async forceAccountStatus(accountId, status) {
 *     const prev = accounts.get(accountId);
 *     if (!prev) throw new TestControllerError('NOT_FOUND', `Account ${accountId} not found`);
 *     accounts.set(accountId, status);
 *     return { success: true, previous_state: prev, current_state: status };
 *   },
 * });
 * ```
 *
 * @example Session-backed store (factory shape)
 *
 * If your session state is persisted (Postgres/Redis/JSONB) and rehydrated into
 * a *new* object per request, closures over module-level state will silently
 * lose data between calls. Pass a factory object: `scenarios` declares the
 * static capability set (answered without invoking your factory), and
 * `createStore` runs per request so the returned store closes over the live
 * session.
 *
 * ```typescript
 * import { registerTestController, CONTROLLER_SCENARIOS, enforceMapCap } from '@adcp/sdk';
 *
 * registerTestController(server, {
 *   scenarios: [CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS, CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS],
 *   async createStore(input) {
 *     const session = await loadSession((input.context as { session_id?: string })?.session_id);
 *     return {
 *       async forceAccountStatus(accountId, status) {
 *         enforceMapCap(session.accountStatuses, accountId, 'account statuses');
 *         const prev = session.accountStatuses.get(accountId) ?? 'active';
 *         session.accountStatuses.set(accountId, status);
 *         await saveSession(session);
 *         return { success: true, previous_state: prev, current_state: status };
 *       },
 *     };
 *   },
 * });
 * ```
 *
 * @example Custom MCP wrapper
 *
 * For wrappers that need `AsyncLocalStorage`, sandbox gating, or a custom task
 * store, bypass `registerTestController` and compose the exported building
 * blocks directly. `TOOL_INPUT_SHAPE` is the canonical Zod shape;
 * `toMcpResponse` produces the same envelope the default registration does.
 *
 * ```typescript
 * import { AsyncLocalStorage } from 'node:async_hooks';
 * import {
 *   handleTestControllerRequest,
 *   toMcpResponse,
 *   TOOL_INPUT_SHAPE,
 * } from '@adcp/sdk';
 *
 * const sessionContext = new AsyncLocalStorage<{ sessionId: string }>();
 * const store = { async forceAccountStatus() { ... } };
 *
 * server.registerTool(
 *   'comply_test_controller',
 *   { description: 'Sandbox only.', inputSchema: TOOL_INPUT_SHAPE },
 *   async input => {
 *     if (!sandboxEnabled()) {
 *       return toMcpResponse({ success: false, error: 'FORBIDDEN', error_detail: 'Sandbox disabled' });
 *     }
 *     return sessionContext.run({ sessionId: (input.context as { session_id: string }).session_id }, async () => {
 *       const response = await handleTestControllerRequest(store, input as Record<string, unknown>);
 *       return toMcpResponse(response);
 *     });
 *   }
 * );
 * ```
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdcpServer } from './adcp-server';
import { ADCP_CAPABILITIES, getSdkServer } from './adcp-server';
import type { GetAdCPCapabilitiesResponse } from '../types/tools.generated';
import type {
  ListScenariosSuccess,
  StateTransitionSuccess,
  SimulationSuccess,
  ForcedDirectiveSuccess,
  ControllerError,
  ComplyTestControllerResponse,
} from '../types/tools.generated';
import type { AccountStatus, MediaBuyStatus, CreativeStatus } from '../types/core.generated';
import { AccountStatusSchema, MediaBuyStatusSchema, CreativeStatusSchema } from '../types/schemas.generated';
import type { McpToolResponse } from './responses';
import { toStructuredContent } from './responses';

// ────────────────────────────────────────────────────────────
// Scenario names
// ────────────────────────────────────────────────────────────

/** Scenario names advertised via `list_scenarios` (force_* and simulate_*).
 * Seed scenarios are NOT advertised — the spec treats them as universal
 * request-time capabilities, not a discoverable subset. The upstream
 * `ListScenariosSuccess['scenarios']` union includes seeds (open-for-
 * extension), so we explicitly subtract them here. */
export type ControllerScenario = Exclude<ListScenariosSuccess['scenarios'][number], SeedScenario>;

/** Scenario names accepted in `scenario` requests but not advertised via
 * `list_scenarios`. Sellers opt in by implementing the matching store method. */
export type SeedScenario =
  | 'seed_product'
  | 'seed_pricing_option'
  | 'seed_creative'
  | 'seed_plan'
  | 'seed_media_buy'
  | 'seed_creative_format';

/**
 * Scenario name constants for force_* and simulate_* (the advertised set).
 * Use in place of string literals for type-safe dispatch in custom wrappers,
 * tests, and factory `scenarios` declarations.
 *
 * ```ts
 * if (input.scenario === CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS) { ... }
 * ```
 */
export const CONTROLLER_SCENARIOS = {
  FORCE_CREATIVE_STATUS: 'force_creative_status',
  FORCE_ACCOUNT_STATUS: 'force_account_status',
  FORCE_MEDIA_BUY_STATUS: 'force_media_buy_status',
  FORCE_SESSION_STATUS: 'force_session_status',
  FORCE_CREATE_MEDIA_BUY_ARM: 'force_create_media_buy_arm',
  FORCE_TASK_COMPLETION: 'force_task_completion',
  SIMULATE_DELIVERY: 'simulate_delivery',
  SIMULATE_BUDGET_SPEND: 'simulate_budget_spend',
} as const satisfies Record<string, ControllerScenario>;

/**
 * Seed scenario name constants. Used by seed dispatch and the
 * {@link createComplyController} domain-grouped façade. Seeds are not
 * advertised via `list_scenarios`.
 */
export const SEED_SCENARIOS = {
  SEED_PRODUCT: 'seed_product',
  SEED_PRICING_OPTION: 'seed_pricing_option',
  SEED_CREATIVE: 'seed_creative',
  SEED_PLAN: 'seed_plan',
  SEED_MEDIA_BUY: 'seed_media_buy',
  SEED_CREATIVE_FORMAT: 'seed_creative_format',
} as const satisfies Record<string, SeedScenario>;

/**
 * Stable `SeedSuccess.message` strings the SDK's `dispatchSeed` emits.
 * Adopters who want to detect first-seed vs idempotent-replay can match
 * on these constants instead of grepping for the literal prose.
 *
 * Third-party sellers MAY emit any string the spec allows (the spec only
 * requires `success: true`); these constants are SDK-specific contracts
 * and not portable across implementations. For cross-implementation
 * replay detection, do not rely on `message`.
 */
export const SEED_MESSAGES = {
  fresh: 'Fixture seeded',
  replay: 'Fixture re-seeded (equivalent)',
} as const;

/**
 * Build-time check: every scenario in the generated union must appear in
 * {@link CONTROLLER_SCENARIOS}. When the protocol adds a new scenario and
 * this type goes non-`never`, TypeScript will reject the assignment below
 * and the build fails until the const is updated.
 */
// `seed_*` scenarios are handled by `createComplyController` (adapter-based),
// not by `registerTestController` (flat-store). Exclude them from the guard so
// new seed_* scenarios added upstream don't break this file — `createComplyController`
// has its own typed-adapter surface and enforces coverage there.
type ExhaustiveScenarioCheck = Exclude<
  ControllerScenario,
  (typeof CONTROLLER_SCENARIOS)[keyof typeof CONTROLLER_SCENARIOS] | SeedScenario
>;
const _scenarioExhaustivenessGuard: ExhaustiveScenarioCheck extends never ? true : never = true;
void _scenarioExhaustivenessGuard;

// ────────────────────────────────────────────────────────────
// Store + factory interfaces
// ────────────────────────────────────────────────────────────

/**
 * Seller-side store for comply_test_controller.
 *
 * Implement the methods for each scenario you support.
 * Unimplemented methods mean that scenario is not advertised in list_scenarios.
 */
export interface TestControllerStore {
  /** Transition a creative to the specified status. */
  forceCreativeStatus?(
    creativeId: string,
    status: CreativeStatus,
    rejectionReason?: string
  ): Promise<StateTransitionSuccess>;

  /** Transition an account to the specified status. */
  forceAccountStatus?(accountId: string, status: AccountStatus): Promise<StateTransitionSuccess>;

  /** Transition a media buy to the specified status. */
  forceMediaBuyStatus?(
    mediaBuyId: string,
    status: MediaBuyStatus,
    rejectionReason?: string
  ): Promise<StateTransitionSuccess>;

  /** Transition an SI session to a terminal status. */
  forceSessionStatus?(
    sessionId: string,
    status: 'complete' | 'terminated',
    terminationReason?: string
  ): Promise<StateTransitionSuccess>;

  /**
   * Register a directive shaping the next `create_media_buy` call from this
   * authenticated sandbox account into the requested arm. The directive is
   * consumed on the next call. `arm: 'submitted'` requires `task_id` so the
   * seller's task envelope is deterministic (the buyer can drive
   * `tasks/get` with the registered id).
   */
  forceCreateMediaBuyArm?(params: {
    arm: 'submitted' | 'input-required';
    task_id?: string;
    message?: string;
  }): Promise<ForcedDirectiveSuccess>;

  /**
   * Transition an in-flight task to `completed` and record the supplied
   * completion payload. The seller MUST deliver `result` verbatim to the
   * buyer's `push_notification_config.url` per the AdCP 3.0 completion path.
   */
  forceTaskCompletion?(taskId: string, result: Record<string, unknown>): Promise<StateTransitionSuccess>;

  /** Inject synthetic delivery data for a media buy. */
  simulateDelivery?(
    mediaBuyId: string,
    params: {
      impressions?: number;
      clicks?: number;
      reported_spend?: { amount: number; currency: string };
      conversions?: number;
    }
  ): Promise<SimulationSuccess>;

  /** Simulate budget consumption to a specified percentage. */
  simulateBudgetSpend?(params: {
    account_id?: string;
    media_buy_id?: string;
    spend_percentage: number;
  }): Promise<SimulationSuccess>;

  /** Seed a product fixture. Returns when the fixture is persisted. */
  seedProduct?(productId: string, fixture: Record<string, unknown> | undefined): Promise<void>;

  /** Seed a pricing option fixture (scoped to a product). */
  seedPricingOption?(
    productId: string,
    pricingOptionId: string,
    fixture: Record<string, unknown> | undefined
  ): Promise<void>;

  /** Seed a creative fixture. */
  seedCreative?(creativeId: string, fixture: Record<string, unknown> | undefined): Promise<void>;

  /** Seed a plan fixture. */
  seedPlan?(planId: string, fixture: Record<string, unknown> | undefined): Promise<void>;

  /** Seed a media-buy fixture. */
  seedMediaBuy?(mediaBuyId: string, fixture: Record<string, unknown> | undefined): Promise<void>;

  /**
   * Seed a creative-format fixture. The seller MUST expose this format ID
   * in `list_creative_formats` responses for the duration of the compliance
   * session.
   */
  seedCreativeFormat?(formatId: string, fixture: Record<string, unknown> | undefined): Promise<void>;

  /**
   * Return outbound HTTP calls the agent has made since `since_timestamp`,
   * scoped to the calling principal. Backs the `upstream_traffic` storyboard
   * validation per spec PR adcontextprotocol/adcp#3816 — runners assert that
   * the adapter actually called upstream with the storyboard-supplied
   * identifiers. The producer-side reference middleware lives at
   * `@adcp/sdk/upstream-recorder`; adopters typically delegate to
   * `recorder.query()` + `toQueryUpstreamTrafficResponse()` rather than
   * implementing this from scratch.
   *
   * Adopters opt in by implementing this method (advertised as
   * `query_upstream_traffic` via `list_scenarios`). NOT yet a member of
   * `CONTROLLER_SCENARIOS` because the schema cache predates the spec PR
   * — the dispatcher accepts the literal `'query_upstream_traffic'`
   * string under the `TOOL_INPUT_SHAPE.scenario: z.string()` open-extension
   * pattern. Once a 3.0.5+ release ships the schema, this scenario will
   * be promoted to a first-class constant.
   */
  queryUpstreamTraffic?(params: {
    since_timestamp?: string;
    endpoint_pattern?: string;
    limit?: number;
  }): Promise<UpstreamTrafficSuccessResponse>;
}

/**
 * Wire shape returned by `queryUpstreamTraffic` — mirrors
 * `UpstreamTrafficSuccess` in `comply-test-controller-response.json`
 * (spec PR adcontextprotocol/adcp#3816). Defined locally rather than
 * imported from the generated types because the schema cache predates
 * the spec PR; switch to the generated type once 3.0.5+ ships.
 *
 * `recorded_calls` is typed as an opaque array — the spec's per-item
 * shape (method / endpoint / url / content_type / payload / timestamp
 * required, host / path / status_code optional) is the runtime contract
 * but isn't expressed in TypeScript here so adopters can return their
 * own typed `RecordedCall[]` (e.g. from `@adcp/sdk/upstream-recorder`)
 * without `exactOptionalPropertyTypes` collisions on optional fields.
 * The wire-shape Ajv test in
 * `test/lib/upstream-recorder-spec-shape.test.js` enforces the runtime
 * contract; adopters validating their own shape against the spec schema
 * get the same guarantee.
 */
export interface UpstreamTrafficSuccessResponse {
  success: true;
  recorded_calls: ReadonlyArray<unknown>;
  total_count: number;
  truncated?: boolean;
  since_timestamp?: string;
}

/**
 * Factory shape for per-request stores. `scenarios` answers list_scenarios
 * without invoking `createStore`, so session-backed factories never run on
 * capability-discovery pings. `createStore` runs once per non-`list_scenarios`
 * request and returns a store bound to the current session.
 */
export interface TestControllerStoreFactory {
  /**
   * Static list of scenarios this factory's stores support. The SDK returns
   * this verbatim for `list_scenarios` — your `createStore` is skipped on
   * capability probes, so you don't have to load a session just to answer.
   */
  scenarios: readonly ControllerScenario[];

  /**
   * Build a {@link TestControllerStore} bound to the current request. Invoked
   * once per non-`list_scenarios` request with the raw tool input. Throw
   * {@link TestControllerError} for typed errors (`FORBIDDEN`, `NOT_FOUND`);
   * other exceptions surface as `INTERNAL_ERROR` with a scrubbed detail.
   */
  createStore(input: Record<string, unknown>): TestControllerStore | Promise<TestControllerStore>;
}

/** Either a pre-built store (simple case) or a per-request factory (session-backed case). */
export type TestControllerStoreOrFactory = TestControllerStore | TestControllerStoreFactory;

function isFactory(x: TestControllerStoreOrFactory): x is TestControllerStoreFactory {
  return typeof (x as TestControllerStoreFactory).createStore === 'function';
}

// ────────────────────────────────────────────────────────────
// Error class for sellers
// ────────────────────────────────────────────────────────────

/**
 * Throw from TestControllerStore methods to return a typed controller error.
 *
 * @example
 * ```typescript
 * throw new TestControllerError('NOT_FOUND', `Account ${id} not found`);
 * throw new TestControllerError('INVALID_TRANSITION', 'Cannot pause a completed buy', 'completed');
 * ```
 */
export class TestControllerError extends Error {
  constructor(
    public readonly code: ControllerError['error'],
    message: string,
    public readonly currentState?: string | null
  ) {
    super(message);
    this.name = 'TestControllerError';
  }
}

// ────────────────────────────────────────────────────────────
// Quota guard
// ────────────────────────────────────────────────────────────

/**
 * Default cap on the number of entries a single session-scoped Map may hold
 * before {@link enforceMapCap} rejects further inserts. Tuned for compliance
 * testing workloads — raise the cap explicitly if you need a higher ceiling.
 */
export const SESSION_ENTRY_CAP = 1000;

/** Max chars of `label` echoed into `enforceMapCap`'s error message. */
const MAX_LABEL_LENGTH = 64;

/** Clamp `label` before interpolating into error messages — attacker-controlled
 * input could otherwise spam logs or derail structured detail parsing. */
function sanitizeLabel(label: string): string {
  const trimmed = typeof label === 'string' ? label : String(label);
  return trimmed.slice(0, MAX_LABEL_LENGTH).replace(/[^\x20-\x7E]/g, '?');
}

/**
 * Reject new entries when `map` has reached `cap`. Use inside
 * {@link TestControllerStore} methods before `.set()` on any Map that
 * accumulates per-session state (account statuses, media-buy states,
 * simulated deliveries). Existing keys are allowed to overwrite — only
 * *net-new* keys are rejected at the cap.
 *
 * Rejects via {@link TestControllerError} with code `INVALID_STATE`, which the
 * dispatcher converts to a typed `ControllerError` response. The caller gets
 * a clear "clear the session or reuse an existing id" error rather than silent
 * LRU eviction that would make compliance tests nondeterministic.
 *
 * @param label - Human-readable plural noun used in the error message
 *   (`"account statuses"`, `"media buy states"`). Intended to be a
 *   caller-controlled string literal; defensively truncated to 64 chars and
 *   stripped of non-printable characters before interpolation so user-controlled
 *   input can't spam logs.
 *
 * @example
 * ```ts
 * async forceAccountStatus(accountId, status) {
 *   enforceMapCap(session.accountStatuses, accountId, 'account statuses');
 *   const prev = session.accountStatuses.get(accountId) ?? 'active';
 *   session.accountStatuses.set(accountId, status);
 *   return { success: true, previous_state: prev, current_state: status };
 * }
 * ```
 */
export function enforceMapCap<V>(
  map: Map<string, V>,
  key: string,
  label: string,
  cap: number = SESSION_ENTRY_CAP
): void {
  if (!map.has(key) && map.size >= cap) {
    throw new TestControllerError(
      'INVALID_STATE',
      `Too many ${sanitizeLabel(label)} entries (limit ${cap}). Clear the session or reuse an existing id.`
    );
  }
}

// ────────────────────────────────────────────────────────────
// Request handler
// ────────────────────────────────────────────────────────────

/**
 * Extension scenarios accepted by the dispatcher but not yet members of
 * `CONTROLLER_SCENARIOS` because the schema cache predates the spec PR
 * that introduced them. Auto-advertised when the matching store method
 * is present. Promoted to first-class constants once a release ships the
 * schema (currently `query_upstream_traffic` from spec PR adcp#3816).
 */
const QUERY_UPSTREAM_TRAFFIC_SCENARIO = 'query_upstream_traffic';

/** Map store method presence to scenario names. */
const SCENARIO_MAP: Array<[keyof TestControllerStore, ControllerScenario]> = [
  ['forceCreativeStatus', CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS],
  ['forceAccountStatus', CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS],
  ['forceMediaBuyStatus', CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS],
  ['forceSessionStatus', CONTROLLER_SCENARIOS.FORCE_SESSION_STATUS],
  ['forceCreateMediaBuyArm', CONTROLLER_SCENARIOS.FORCE_CREATE_MEDIA_BUY_ARM],
  ['forceTaskCompletion', CONTROLLER_SCENARIOS.FORCE_TASK_COMPLETION],
  ['simulateDelivery', CONTROLLER_SCENARIOS.SIMULATE_DELIVERY],
  ['simulateBudgetSpend', CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND],
];

/**
 * Canonical scenarios from the generated `ListScenariosSuccess` enum. Used
 * for the typed `compliance_testing.scenarios` capability block, which the
 * generated Zod validator constrains to the enum's literal union — an
 * extension scenario like `query_upstream_traffic` (not yet in the schema
 * cache) gets rejected by `get_adcp_capabilities` response validation when
 * its enum hasn't picked up the spec PR yet.
 */
function scenariosFromStore(store: TestControllerStore): ControllerScenario[] {
  return SCENARIO_MAP.filter(([method]) => typeof store[method] === 'function').map(([, scenario]) => scenario);
}

/**
 * All scenarios — canonical + extensions accepted by the dispatcher but
 * not yet in `CONTROLLER_SCENARIOS`. Used for `list_scenarios` which is
 * open-for-extension (the `comply_test_controller`'s discovery scenario
 * accepts unknown strings per the spec).
 */
function allScenariosFromStore(store: TestControllerStore): string[] {
  const out: string[] = scenariosFromStore(store);
  if (typeof store.queryUpstreamTraffic === 'function') out.push(QUERY_UPSTREAM_TRAFFIC_SCENARIO);
  return out;
}

function controllerError(
  code: ControllerError['error'],
  detail: string,
  currentState?: string | null
): ControllerError {
  return {
    success: false,
    error: code,
    error_detail: detail,
    ...(currentState !== undefined && { current_state: currentState }),
  };
}

// ────────────────────────────────────────────────────────────
// Seed fixture idempotency
// ────────────────────────────────────────────────────────────

/**
 * Per-controller cache for seed-fixture equivalence checks. The handler uses
 * it to enforce the spec-level rule that re-seeding with the same ID and an
 * equivalent fixture yields `SeedSuccess` with `message: "Fixture re-seeded
 * (equivalent)"`, while a divergent fixture returns `INVALID_PARAMS`.
 *
 * Passed explicitly to {@link handleTestControllerRequest} so custom wrappers
 * can scope the cache to a session, tenant, or test run. Keys are
 * scenario-scoped (`seed_creative:cr-1`) to avoid cross-kind collisions.
 */
export interface SeedFixtureCache {
  get(key: string): Record<string, unknown> | undefined;
  set(key: string, fixture: Record<string, unknown>): void;
  has(key: string): boolean;
}

/** Build an in-memory {@link SeedFixtureCache}. Capped at {@link SESSION_ENTRY_CAP}
 * net-new keys to bound memory from a sandbox-authed caller that keeps seeding
 * fresh IDs. Existing keys are always writable so re-seeds continue to work at
 * the cap. Raise the cap explicitly for high-volume test runs. */
export function createSeedFixtureCache(cap: number = SESSION_ENTRY_CAP): SeedFixtureCache {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get: k => map.get(k),
    set: (k, v) => {
      if (!map.has(k) && map.size >= cap) {
        throw new TestControllerError(
          'INVALID_STATE',
          `Seed fixture cache full (limit ${cap}). Clear the session or reuse an existing id.`
        );
      }
      map.set(k, v);
    },
    has: k => map.has(k),
  };
}

/** Canonical JSON for equivalence checks. Sorts object keys recursively so
 * `{a:1,b:2}` matches `{b:2,a:1}`. Arrays remain order-sensitive. Uses a
 * seen-set to short-circuit circular references rather than stack-overflowing. */
function canonicalJson(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value as object)) return '"__cycle__"';
  seen.add(value as object);
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v, seen)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], seen)}`);
  return `{${entries.join(',')}}`;
}

function fixturesEquivalent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    // BigInt, symbols, or other non-JSON-safe values — treat as divergent so
    // the caller gets a clear INVALID_PARAMS instead of an INTERNAL_ERROR.
    return false;
  }
}

/** Dispatch a seed scenario through the correct adapter method, honoring the
 * spec idempotency rules when a {@link SeedFixtureCache} is provided. */
/**
 * Build the seed-cache key for a scenario. When `scope` is present (the
 * request's `account.account_id`), it's prefixed so two sandbox accounts
 * on one server can each seed the same `product_id` with divergent
 * fixtures without colliding in the process-wide `SeedFixtureCache`.
 *
 * Without scope (legacy callers, or requests with no `account` envelope),
 * the unscoped key is used — preserving the pre-#1215 behavior. Adopters
 * who relied on cross-account replay equivalence (rare, since storyboards
 * usually scope per account anyway) are unaffected when their requests
 * don't carry an `account` block.
 */
function makeSeedCacheKey(unscopedKey: string, scope: string | undefined): string {
  return scope != null && scope.length > 0 ? `${scope}:${unscopedKey}` : unscopedKey;
}

async function dispatchSeed(
  store: TestControllerStore,
  scenario: SeedScenario,
  params: Record<string, unknown> | undefined,
  cache: SeedFixtureCache | undefined,
  scope: string | undefined
): Promise<ComplyTestControllerResponse> {
  // Validate fixture is a plain object (not null, array, or primitive) before
  // casting — the adapter signature promises Record<string, unknown>.
  const rawFixture = params?.fixture;
  if (
    rawFixture !== undefined &&
    (typeof rawFixture !== 'object' || Array.isArray(rawFixture) || rawFixture === null)
  ) {
    return controllerError(
      'INVALID_PARAMS',
      `${scenario} requires params.fixture to be an object (got ${Array.isArray(rawFixture) ? 'array' : typeof rawFixture})`
    );
  }
  const fixture = (rawFixture as Record<string, unknown> | undefined) ?? {};
  // Reject keys that can pollute prototypes when adapters spread the fixture
  // into plain objects. Checked only at the top level — nested uses
  // `Object.hasOwn` or similar in the adapter's own data layer.
  for (const key of Object.keys(fixture)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return controllerError(
        'INVALID_PARAMS',
        `${scenario} fixture key ${JSON.stringify(key)} is reserved and rejected to prevent prototype pollution`
      );
    }
  }

  // Route to adapter + pick a cache key unique per (kind, id).
  type SeedDispatch = { key: string; invoke: () => Promise<void> };
  let dispatch: SeedDispatch | null = null;
  let missingParam: string | null = null;

  switch (scenario) {
    case SEED_SCENARIOS.SEED_PRODUCT: {
      if (!params?.product_id) {
        missingParam = 'seed_product requires params.product_id';
        break;
      }
      if (!store.seedProduct) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
      const productId = params.product_id as string;
      dispatch = {
        key: makeSeedCacheKey(`seed_product:${productId}`, scope),
        invoke: () => store.seedProduct!(productId, fixture),
      };
      break;
    }
    case SEED_SCENARIOS.SEED_PRICING_OPTION: {
      if (!params?.product_id || !params?.pricing_option_id) {
        missingParam = 'seed_pricing_option requires params.product_id and params.pricing_option_id';
        break;
      }
      if (!store.seedPricingOption) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
      const productId = params.product_id as string;
      const pricingOptionId = params.pricing_option_id as string;
      dispatch = {
        key: makeSeedCacheKey(`seed_pricing_option:${productId}:${pricingOptionId}`, scope),
        invoke: () => store.seedPricingOption!(productId, pricingOptionId, fixture),
      };
      break;
    }
    case SEED_SCENARIOS.SEED_CREATIVE: {
      if (!params?.creative_id) {
        missingParam = 'seed_creative requires params.creative_id';
        break;
      }
      if (!store.seedCreative) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
      const creativeId = params.creative_id as string;
      dispatch = {
        key: makeSeedCacheKey(`seed_creative:${creativeId}`, scope),
        invoke: () => store.seedCreative!(creativeId, fixture),
      };
      break;
    }
    case SEED_SCENARIOS.SEED_PLAN: {
      if (!params?.plan_id) {
        missingParam = 'seed_plan requires params.plan_id';
        break;
      }
      if (!store.seedPlan) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
      const planId = params.plan_id as string;
      dispatch = {
        key: makeSeedCacheKey(`seed_plan:${planId}`, scope),
        invoke: () => store.seedPlan!(planId, fixture),
      };
      break;
    }
    case SEED_SCENARIOS.SEED_MEDIA_BUY: {
      if (!params?.media_buy_id) {
        missingParam = 'seed_media_buy requires params.media_buy_id';
        break;
      }
      if (!store.seedMediaBuy) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
      const mediaBuyId = params.media_buy_id as string;
      dispatch = {
        key: makeSeedCacheKey(`seed_media_buy:${mediaBuyId}`, scope),
        invoke: () => store.seedMediaBuy!(mediaBuyId, fixture),
      };
      break;
    }
    case SEED_SCENARIOS.SEED_CREATIVE_FORMAT: {
      if (!params?.format_id) {
        missingParam = 'seed_creative_format requires params.format_id';
        break;
      }
      if (!store.seedCreativeFormat) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
      const formatId = params.format_id as string;
      dispatch = {
        key: makeSeedCacheKey(`seed_creative_format:${formatId}`, scope),
        invoke: () => store.seedCreativeFormat!(formatId, fixture),
      };
      break;
    }
  }

  if (missingParam) return controllerError('INVALID_PARAMS', missingParam);
  if (!dispatch) return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);

  // Spec idempotency: same ID + equivalent fixture = existing; divergent = INVALID_PARAMS.
  // We also handle caches where has() can race with get() (TTL/LRU eviction) —
  // a missing prior entry is treated as a fresh seed rather than a crash.
  const prior = cache?.has(dispatch.key) ? cache.get(dispatch.key) : undefined;
  if (prior !== undefined) {
    if (!fixturesEquivalent(prior, fixture)) {
      return controllerError(
        'INVALID_PARAMS',
        `Fixture for ${sanitizeLabel(dispatch.key)} diverges from the previously seeded fixture. ` +
          'Seed replays must carry an equivalent fixture or choose a new id.'
      );
    }
    await dispatch.invoke();
    // SeedSuccess (3.0.1+): message-only arm. The schema's `oneOf` excludes
    // `previous_state`/`current_state` from this branch — seeds are
    // pre-population, not entity transitions. {@link SEED_MESSAGES} carries
    // the SDK-specific replay-detection token.
    return { success: true, message: SEED_MESSAGES.replay };
  }

  await dispatch.invoke();
  cache?.set(dispatch.key, fixture);
  return { success: true, message: SEED_MESSAGES.fresh };
}

async function handleTestControllerRequestImpl(
  storeOrFactory: TestControllerStoreOrFactory,
  input: Record<string, unknown>,
  options?: { seedCache?: SeedFixtureCache }
): Promise<ComplyTestControllerResponse> {
  const scenario = input.scenario as string | undefined;
  if (!scenario) {
    return controllerError('INVALID_PARAMS', 'Missing required field: scenario');
  }

  // list_scenarios is a stateless capability probe — answer it without
  // invoking the factory so session-backed factories don't need to tolerate
  // sessionless probes.
  if (scenario === 'list_scenarios') {
    const scenarios = isFactory(storeOrFactory) ? [...storeOrFactory.scenarios] : allScenariosFromStore(storeOrFactory);
    // Cast: the generated union doesn't yet include extension scenarios
    // (e.g. `query_upstream_traffic` from spec PR adcp#3816, schema not
    // released yet). The wire shape says `scenarios` is open-for-extension
    // — runners and sellers MUST accept unknown strings — so the runtime
    // shape is correct. Drop the cast once the schema cache picks them up.
    return { success: true, scenarios } as unknown as ListScenariosSuccess;
  }

  let store: TestControllerStore;
  try {
    store = isFactory(storeOrFactory) ? await storeOrFactory.createStore(input) : storeOrFactory;
  } catch (err) {
    if (err instanceof TestControllerError) {
      return controllerError(err.code, err.message, err.currentState);
    }
    return controllerError(
      'INTERNAL_ERROR',
      `Failed to resolve test controller store for scenario ${sanitizeLabel(scenario)}`
    );
  }

  const params = input.params as Record<string, unknown> | undefined;

  try {
    switch (scenario) {
      case CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS: {
        if (!store.forceCreativeStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.creative_id || !params?.status) {
          return controllerError(
            'INVALID_PARAMS',
            'force_creative_status requires params.creative_id and params.status'
          );
        }
        const creativeStatus = CreativeStatusSchema.safeParse(params.status);
        if (!creativeStatus.success) {
          return controllerError('INVALID_PARAMS', `Invalid creative status: ${params.status}`);
        }
        return await store.forceCreativeStatus(
          params.creative_id as string,
          creativeStatus.data,
          params.rejection_reason as string | undefined
        );
      }

      case CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS: {
        if (!store.forceAccountStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.account_id || !params?.status) {
          return controllerError('INVALID_PARAMS', 'force_account_status requires params.account_id and params.status');
        }
        const accountStatus = AccountStatusSchema.safeParse(params.status);
        if (!accountStatus.success) {
          return controllerError('INVALID_PARAMS', `Invalid account status: ${params.status}`);
        }
        return await store.forceAccountStatus(params.account_id as string, accountStatus.data);
      }

      case CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS: {
        if (!store.forceMediaBuyStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.media_buy_id || !params?.status) {
          return controllerError(
            'INVALID_PARAMS',
            'force_media_buy_status requires params.media_buy_id and params.status'
          );
        }
        const mediaBuyStatus = MediaBuyStatusSchema.safeParse(params.status);
        if (!mediaBuyStatus.success) {
          return controllerError('INVALID_PARAMS', `Invalid media buy status: ${params.status}`);
        }
        return await store.forceMediaBuyStatus(
          params.media_buy_id as string,
          mediaBuyStatus.data,
          params.rejection_reason as string | undefined
        );
      }

      case CONTROLLER_SCENARIOS.FORCE_SESSION_STATUS: {
        if (!store.forceSessionStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.session_id || !params?.status) {
          return controllerError('INVALID_PARAMS', 'force_session_status requires params.session_id and params.status');
        }
        const validSessionStatuses = ['complete', 'terminated'];
        if (!validSessionStatuses.includes(params.status as string)) {
          return controllerError('INVALID_PARAMS', `Invalid session status: ${params.status}`);
        }
        return await store.forceSessionStatus(
          params.session_id as string,
          params.status as 'complete' | 'terminated',
          params.termination_reason as string | undefined
        );
      }

      case CONTROLLER_SCENARIOS.SIMULATE_DELIVERY: {
        if (!store.simulateDelivery) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.media_buy_id) {
          return controllerError('INVALID_PARAMS', 'simulate_delivery requires params.media_buy_id');
        }
        return await store.simulateDelivery(params.media_buy_id as string, {
          impressions: params.impressions as number | undefined,
          clicks: params.clicks as number | undefined,
          reported_spend: params.reported_spend as { amount: number; currency: string } | undefined,
          conversions: params.conversions as number | undefined,
        });
      }

      case CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND: {
        if (!store.simulateBudgetSpend) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (params?.spend_percentage === undefined || params?.spend_percentage === null) {
          return controllerError('INVALID_PARAMS', 'simulate_budget_spend requires params.spend_percentage');
        }
        if (!params?.account_id && !params?.media_buy_id) {
          return controllerError(
            'INVALID_PARAMS',
            'simulate_budget_spend requires params.account_id or params.media_buy_id'
          );
        }
        return await store.simulateBudgetSpend({
          account_id: params.account_id as string | undefined,
          media_buy_id: params.media_buy_id as string | undefined,
          spend_percentage: params.spend_percentage as number,
        });
      }

      case CONTROLLER_SCENARIOS.FORCE_CREATE_MEDIA_BUY_ARM: {
        if (!store.forceCreateMediaBuyArm) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        const arm = params?.arm;
        if (arm !== 'submitted' && arm !== 'input-required') {
          return controllerError(
            'INVALID_PARAMS',
            "force_create_media_buy_arm requires params.arm = 'submitted' or 'input-required'"
          );
        }
        if (arm === 'submitted' && !params?.task_id) {
          return controllerError(
            'INVALID_PARAMS',
            "force_create_media_buy_arm with arm='submitted' requires params.task_id"
          );
        }
        // Spec: task_id is "Present only when arm is 'submitted'" — reject
        // it on the input-required arm so sellers can rely on the field's
        // presence as a discriminator.
        if (arm === 'input-required' && params?.task_id !== undefined) {
          return controllerError(
            'INVALID_PARAMS',
            "force_create_media_buy_arm with arm='input-required' must not include params.task_id"
          );
        }
        return await store.forceCreateMediaBuyArm({
          arm,
          task_id: params?.task_id as string | undefined,
          message: params?.message as string | undefined,
        });
      }

      case CONTROLLER_SCENARIOS.FORCE_TASK_COMPLETION: {
        if (!store.forceTaskCompletion) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.task_id) {
          return controllerError('INVALID_PARAMS', 'force_task_completion requires params.task_id');
        }
        // Reject arrays explicitly — `typeof [] === 'object'` would let an
        // array slip past the object check, but `result` is a structured
        // completion payload (validates against async-response-data.json),
        // never an array.
        if (!params?.result || typeof params.result !== 'object' || Array.isArray(params.result)) {
          return controllerError(
            'INVALID_PARAMS',
            'force_task_completion requires params.result (completion payload object)'
          );
        }
        return await store.forceTaskCompletion(params.task_id as string, params.result as Record<string, unknown>);
      }

      case SEED_SCENARIOS.SEED_PRODUCT:
      case SEED_SCENARIOS.SEED_PRICING_OPTION:
      case SEED_SCENARIOS.SEED_CREATIVE:
      case SEED_SCENARIOS.SEED_PLAN:
      case SEED_SCENARIOS.SEED_MEDIA_BUY:
      case SEED_SCENARIOS.SEED_CREATIVE_FORMAT: {
        // Per-account seed-cache scope (issue #1215). Two sandbox accounts on
        // one server can each seed the same `product_id` with divergent
        // fixtures; without a scope prefix the cache treats divergent replays
        // as INVALID_PARAMS even when each account's fixture is internally
        // self-consistent. Read the request envelope's `account.account_id`
        // (no resolver call here — test-controller is a generic helper that
        // doesn't know about platform.accounts.resolve, and read-time
        // misalignment is fine because the cache only governs idempotency,
        // not user-visible state). Empty/missing → unscoped (legacy keys).
        const account = input.account;
        const scope =
          account != null && typeof account === 'object'
            ? (() => {
                const id = (account as { account_id?: unknown }).account_id;
                return typeof id === 'string' && id.length > 0 ? id : undefined;
              })()
            : undefined;
        return await dispatchSeed(store, scenario as SeedScenario, params, options?.seedCache, scope);
      }

      // Extension scenarios — accepted by the dispatcher but not yet
      // members of CONTROLLER_SCENARIOS. Promoted to first-class constants
      // once a release ships the schema. Today: just `query_upstream_traffic`
      // (spec PR adcp#3816).
      case QUERY_UPSTREAM_TRAFFIC_SCENARIO: {
        if (!store.queryUpstreamTraffic) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        const queryParams = (params ?? {}) as {
          since_timestamp?: string;
          endpoint_pattern?: string;
          limit?: number;
        };
        // Cast through ComplyTestControllerResponse — UpstreamTrafficSuccess
        // isn't in the generated union yet (3.0.4 cache predates spec PR
        // #3816). The runtime value matches `UpstreamTrafficSuccess`.
        return (await store.queryUpstreamTraffic(queryParams)) as unknown as ComplyTestControllerResponse;
      }

      default:
        return controllerError('UNKNOWN_SCENARIO', 'Unrecognized scenario name');
    }
  } catch (err) {
    if (err instanceof TestControllerError) {
      return controllerError(err.code, err.message, err.currentState);
    }
    return controllerError('INTERNAL_ERROR', 'An unexpected error occurred in the test controller store');
  }
}

/**
 * Handle a `comply_test_controller` request. Exported so custom MCP wrappers
 * can compose it with their own middleware (AsyncLocalStorage, sandbox gating,
 * logging) without going through {@link registerTestController}.
 *
 * `list_scenarios` is answered from the static capability set (store method
 * presence for plain stores, `factory.scenarios` for factories) and never
 * invokes `factory.createStore`. Session-backed factories can therefore load
 * real session state unconditionally.
 *
 * `input.context` is echoed into every response branch so correlation IDs
 * round-trip per the `comply-test-controller-response.json` schema.
 */
export async function handleTestControllerRequest(
  storeOrFactory: TestControllerStoreOrFactory,
  input: Record<string, unknown>,
  options?: { seedCache?: SeedFixtureCache }
): Promise<ComplyTestControllerResponse> {
  const ctx = input.context;
  const result = await handleTestControllerRequestImpl(storeOrFactory, input, options);
  if (ctx !== undefined && typeof ctx === 'object' && ctx !== null && result.context === undefined) {
    return { ...result, context: ctx } as ComplyTestControllerResponse;
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// MCP envelope helpers
// ────────────────────────────────────────────────────────────

function summarize(data: ComplyTestControllerResponse): string {
  if (data.success === false) return `Controller error: ${data.error}`;
  if ('scenarios' in data) return `Supported scenarios: ${data.scenarios.join(', ')}`;
  if ('previous_state' in data) {
    return `Transitioned from ${data.previous_state} to ${data.current_state}`;
  }
  if ('simulated' in data) return `Simulation complete: ${JSON.stringify(data.simulated)}`;
  if ('forced' in data) return `Directive registered: arm=${data.forced.arm}`;
  // SeedSuccess (3.0.1+): message-only arm. dispatchSeed sets the message
  // to 'Fixture seeded' / 'Fixture re-seeded (equivalent)'; third-party
  // sellers may emit other strings (or none — the spec only requires
  // success).
  return data.message ?? 'Scenario succeeded';
}

/**
 * Wrap a {@link ComplyTestControllerResponse} in an MCP tool response envelope
 * (`content` + `structuredContent` + `isError`). Exported so custom wrappers
 * can reuse the same summary/error shape as {@link registerTestController}.
 */
export function toMcpResponse(data: ComplyTestControllerResponse): McpToolResponse & { isError?: true } {
  const isError = data.success === false;
  return {
    content: [{ type: 'text', text: summarize(data) }],
    structuredContent: toStructuredContent(data),
    ...(isError && { isError: true }),
  };
}

/**
 * Canonical Zod input schema for the `comply_test_controller` tool. Pass as
 * the `inputSchema` argument to `server.registerTool(...)` in custom wrappers
 * so the request shape stays in sync with {@link registerTestController}.
 *
 * Matches `ComplyTestControllerRequest` from the generated schema: `scenario`
 * (required), `params` (scenario-specific), and the universal `context` / `ext`
 * envelope fields. No top-level `account` or `brand` — AdCP routes account
 * and brand context through `context` on this tool.
 *
 * **Extending for vendor fields.** Custom wrappers that route sandbox gating
 * or tenant scoping on top-level fields can extend the shape locally.
 * Both `account` and `brand` are commonly added — storyboard fixtures and
 * v5-shaped wrappers often send them alongside `params`:
 *
 * ```ts
 * const MY_SHAPE = {
 *   ...TOOL_INPUT_SHAPE,
 *   account: z.object({ sandbox: z.boolean() }).passthrough().optional(),
 *   brand: z.object({ domain: z.string() }).passthrough().optional(),
 * };
 * server.registerTool(
 *   'comply_test_controller',
 *   { description: 'Sandbox only.', inputSchema: MY_SHAPE },
 *   async input => {
 *     if (input.account?.sandbox !== true) return toMcpResponse({ ... });
 *     return toMcpResponse(await handleTestControllerRequest(store, input as Record<string, unknown>));
 *   }
 * );
 * ```
 *
 * Adopters routing through `createAdcpServerFromPlatform({ complyTest })`
 * pass the same fields via `complyTest.inputSchema` (see
 * `ComplyControllerConfig.inputSchema` in `@adcp/sdk/testing`).
 *
 * This keeps the default registration protocol-compliant while giving
 * wrapper authors a documented extension point.
 */
export const TOOL_INPUT_SHAPE = {
  scenario: z.string().describe('Scenario to execute (e.g., list_scenarios, force_account_status)'),
  params: z.record(z.string(), z.unknown()).optional().describe('Scenario-specific parameters'),
  context: z.record(z.string(), z.unknown()).optional().describe('AdCP context object'),
  ext: z.record(z.string(), z.unknown()).optional().describe('AdCP extension object'),
};

// ────────────────────────────────────────────────────────────
// MCP tool registration
// ────────────────────────────────────────────────────────────

/**
 * Register the `comply_test_controller` tool on an MCP server.
 *
 * Accepts a plain {@link TestControllerStore} (scenarios inferred from
 * implemented methods) or a {@link TestControllerStoreFactory} (scenarios
 * declared explicitly; `createStore` runs per request for session-backed
 * state). See the module-level examples for both patterns.
 *
 * The `server` argument takes either an `AdcpServer` from
 * `createAdcpServer()` or a raw SDK `McpServer` from
 * `createTaskCapableServer()` — the helper unwraps the opaque handle
 * when needed so tool registration reaches the underlying SDK server.
 */
export function registerTestController(
  server: AdcpServer | McpServer,
  storeOrFactory: TestControllerStoreOrFactory,
  options?: { seedCache?: SeedFixtureCache }
): void {
  const mcp = getSdkServer(server as AdcpServer) ?? (server as McpServer);
  // Per-registration cache so seed idempotency holds across all requests on
  // this server instance. Callers can supply their own cache to scope by
  // session or tenant.
  const seedCache = options?.seedCache ?? createSeedFixtureCache();

  // Per AdCP 3.0, comply_test_controller support is declared via the
  // top-level `compliance_testing` capability block — NOT as an entry in
  // `supported_protocols`. When we've been given an AdcpServer produced by
  // createAdcpServer, auto-populate that block. The scenarios list comes
  // from the factory's static `scenarios` (factory shape) or is inferred
  // from the plain store's method presence.
  const capsBag = (server as unknown as Record<PropertyKey, unknown>)[ADCP_CAPABILITIES] as
    | GetAdCPCapabilitiesResponse
    | undefined;
  if (capsBag) {
    const incoming = isFactory(storeOrFactory) ? [...storeOrFactory.scenarios] : scenariosFromStore(storeOrFactory);
    if (incoming.length > 0) {
      // Merge with any previously-declared scenarios rather than silently
      // dropping them. A server can wire more than one controller (e.g.
      // media-buy + governance) and each call should contribute its
      // scenarios to the advertised set.
      const existing = (capsBag.compliance_testing?.scenarios ?? []) as readonly string[];
      const merged = Array.from(new Set([...existing, ...incoming]));
      capsBag.compliance_testing = { scenarios: merged } as GetAdCPCapabilitiesResponse['compliance_testing'];
    }
  }
  mcp.registerTool(
    'comply_test_controller',
    {
      description: 'Triggers seller-side state transitions for compliance testing. Sandbox only.',
      inputSchema: TOOL_INPUT_SHAPE,
    },
    (async (input: Record<string, unknown>) => {
      const response = await handleTestControllerRequest(storeOrFactory, input, {
        seedCache,
      });
      return toMcpResponse(response);
    }) as Parameters<typeof mcp.registerTool>[2]
  );
}
