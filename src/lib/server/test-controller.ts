/**
 * Server-side comply_test_controller implementation.
 *
 * Sellers typically call `registerTestController(server, store)` to add the
 * `comply_test_controller` tool to their MCP server. The TestControllerStore
 * interface lets sellers wire up their own state management while the SDK
 * handles request parsing, scenario dispatch, and response formatting.
 *
 * @example Basic usage — single in-memory store
 * ```typescript
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { registerTestController, TestControllerError } from '@adcp/client';
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
 * import { registerTestController, CONTROLLER_SCENARIOS, enforceMapCap } from '@adcp/client';
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
 * } from '@adcp/client';
 *
 * const sessionContext = new AsyncLocalStorage<{ sessionId: string }>();
 * const store = { async forceAccountStatus() { ... } };
 *
 * server.tool('comply_test_controller', 'Sandbox only.', TOOL_INPUT_SHAPE, async input => {
 *   if (!sandboxEnabled()) {
 *     return toMcpResponse({ success: false, error: 'FORBIDDEN', error_detail: 'Sandbox disabled' });
 *   }
 *   return sessionContext.run({ sessionId: (input.context as { session_id: string }).session_id }, async () => {
 *     const response = await handleTestControllerRequest(store, input as Record<string, unknown>);
 *     return toMcpResponse(response);
 *   });
 * });
 * ```
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdcpServer } from './adcp-server';
import { getSdkServer } from './adcp-server';
import type {
  ListScenariosSuccess,
  StateTransitionSuccess,
  SimulationSuccess,
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

/** Scenario names the controller can support (derived from generated schema). */
export type ControllerScenario = ListScenariosSuccess['scenarios'][number];

/**
 * Scenario name constants. Use in place of string literals for type-safe
 * dispatch in custom wrappers, tests, and factory `scenarios` declarations.
 *
 * Adding a scenario to the generated `ListScenariosSuccess` schema requires
 * adding a matching entry here — the `ExhaustiveScenarioCheck` type below
 * breaks the build if this map falls out of sync with the protocol.
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
  SIMULATE_DELIVERY: 'simulate_delivery',
  SIMULATE_BUDGET_SPEND: 'simulate_budget_spend',
} as const satisfies Record<string, ControllerScenario>;

/**
 * Build-time check: every scenario in the generated union must appear in
 * {@link CONTROLLER_SCENARIOS}. When the protocol adds a new scenario and
 * this type goes non-`never`, TypeScript will reject the assignment below
 * and the build fails until the const is updated.
 */
type ExhaustiveScenarioCheck = Exclude<
  ControllerScenario,
  (typeof CONTROLLER_SCENARIOS)[keyof typeof CONTROLLER_SCENARIOS]
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

/** Map store method presence to scenario names. */
const SCENARIO_MAP: Array<[keyof TestControllerStore, ControllerScenario]> = [
  ['forceCreativeStatus', CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS],
  ['forceAccountStatus', CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS],
  ['forceMediaBuyStatus', CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS],
  ['forceSessionStatus', CONTROLLER_SCENARIOS.FORCE_SESSION_STATUS],
  ['simulateDelivery', CONTROLLER_SCENARIOS.SIMULATE_DELIVERY],
  ['simulateBudgetSpend', CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND],
];

function scenariosFromStore(store: TestControllerStore): ControllerScenario[] {
  return SCENARIO_MAP.filter(([method]) => typeof store[method] === 'function').map(([, scenario]) => scenario);
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

/**
 * Handle a `comply_test_controller` request. Exported so custom MCP wrappers
 * can compose it with their own middleware (AsyncLocalStorage, sandbox gating,
 * logging) without going through {@link registerTestController}.
 *
 * `list_scenarios` is answered from the static capability set (store method
 * presence for plain stores, `factory.scenarios` for factories) and never
 * invokes `factory.createStore`. Session-backed factories can therefore load
 * real session state unconditionally.
 */
export async function handleTestControllerRequest(
  storeOrFactory: TestControllerStoreOrFactory,
  input: Record<string, unknown>
): Promise<ComplyTestControllerResponse> {
  const scenario = input.scenario as string | undefined;
  if (!scenario) {
    return controllerError('INVALID_PARAMS', 'Missing required field: scenario');
  }

  // list_scenarios is a stateless capability probe — answer it without
  // invoking the factory so session-backed factories don't need to tolerate
  // sessionless probes.
  if (scenario === 'list_scenarios') {
    const scenarios = isFactory(storeOrFactory) ? [...storeOrFactory.scenarios] : scenariosFromStore(storeOrFactory);
    return { success: true, scenarios };
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

// ────────────────────────────────────────────────────────────
// MCP envelope helpers
// ────────────────────────────────────────────────────────────

function summarize(data: ComplyTestControllerResponse): string {
  if (data.success === false) return `Controller error: ${data.error}`;
  if ('scenarios' in data) return `Supported scenarios: ${data.scenarios.join(', ')}`;
  if ('previous_state' in data) return `Transitioned from ${data.previous_state} to ${data.current_state}`;
  return `Simulation complete: ${JSON.stringify(data.simulated)}`;
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
 * the `inputSchema` argument to `server.tool(...)` in custom wrappers so the
 * request shape stays in sync with {@link registerTestController}.
 *
 * Matches `ComplyTestControllerRequest` from the generated schema: `scenario`
 * (required), `params` (scenario-specific), and the universal `context` / `ext`
 * envelope fields. No top-level `account` — AdCP routes account context
 * through `context` on this tool.
 *
 * **Extending for vendor fields.** Custom wrappers that route sandbox gating
 * or tenant scoping on top-level fields can extend the shape locally:
 *
 * ```ts
 * const MY_SHAPE = {
 *   ...TOOL_INPUT_SHAPE,
 *   account: z.object({ sandbox: z.boolean() }).passthrough().optional(),
 * };
 * server.tool('comply_test_controller', 'Sandbox only.', MY_SHAPE, async input => {
 *   if (input.account?.sandbox !== true) return toMcpResponse({ ... });
 *   return toMcpResponse(await handleTestControllerRequest(store, input as Record<string, unknown>));
 * });
 * ```
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
  storeOrFactory: TestControllerStoreOrFactory
): void {
  const mcp = getSdkServer(server as AdcpServer) ?? (server as McpServer);
  mcp.tool(
    'comply_test_controller',
    'Triggers seller-side state transitions for compliance testing. Sandbox only.',
    TOOL_INPUT_SHAPE,
    async input => {
      const response = await handleTestControllerRequest(storeOrFactory, input as Record<string, unknown>);
      return toMcpResponse(response);
    }
  );
}
