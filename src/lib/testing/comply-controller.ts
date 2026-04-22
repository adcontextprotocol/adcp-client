/**
 * Seller-side scaffold for the `comply_test_controller` tool.
 *
 * `createComplyController` turns a set of domain-grouped adapters into the
 * pieces needed to register the tool on an MCP server: a tool definition, a
 * raw handler, an MCP-envelope handler, and a one-call `register(server)`.
 *
 * The helper owns:
 *   - Dispatching `scenario` to the correct adapter
 *   - Param validation + typed error envelopes (`UNKNOWN_SCENARIO`,
 *     `INVALID_PARAMS`, `NOT_FOUND`, `INVALID_TRANSITION`, `FORBIDDEN`)
 *   - Seed re-seed idempotency (same id + equivalent fixture =
 *     `previous_state: "existing"`; divergent fixture = `INVALID_PARAMS`)
 *   - Optional sandbox gating at both `tools/list` and per-request level
 *
 * The helper does NOT own the state machine. Transition enforcement lives
 * inside your adapters so production and compliance testing share one source
 * of truth — throw `TestControllerError('INVALID_TRANSITION', …)` from the
 * adapter when a transition is disallowed.
 *
 * For custom MCP wrappers that need AsyncLocalStorage, sandbox gating at the
 * transport layer, or a session-backed store factory, compose
 * `handleTestControllerRequest`, `toMcpResponse`, and `TOOL_INPUT_SHAPE` from
 * `@adcp/client/server` directly — the flat-store surface documented there.
 *
 * @example
 * ```ts
 * import { createComplyController } from '@adcp/client/testing';
 *
 * const controller = createComplyController({
 *   sandboxGate: input => input.auth?.sandbox === true,
 *   seed: {
 *     product: (params) => productRepo.upsert(params.product_id, params.fixture),
 *     creative: (params) => creativeRepo.upsert(params.creative_id, params.fixture),
 *   },
 *   force: {
 *     creative_status: (params) => creativeRepo.transition(params.creative_id, params.status),
 *   },
 * });
 *
 * controller.register(server);
 * ```
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CONTROLLER_SCENARIOS,
  TOOL_INPUT_SHAPE,
  createSeedFixtureCache,
  handleTestControllerRequest,
  toMcpResponse,
  type ControllerScenario,
  type SeedFixtureCache,
  type TestControllerStore,
} from '../server/test-controller';
import { getSdkServer, type AdcpServer } from '../server/adcp-server';
import type {
  ComplyTestControllerResponse,
  ControllerError,
  SimulationSuccess,
  StateTransitionSuccess,
} from '../types/tools.generated';
import type { AccountStatus, CreativeStatus, MediaBuyStatus } from '../types/core.generated';
import type { McpToolResponse } from '../server/responses';

// ────────────────────────────────────────────────────────────
// Adapter param shapes
// ────────────────────────────────────────────────────────────

/** Common second argument every adapter receives: the raw tool input so
 * adapters can read `context.session_id`, `ext`, or vendor-specific fields. */
export interface ComplyControllerContext {
  /** The tool input as received over the wire, pre-validation. */
  input: Record<string, unknown>;
}

/** Params for `seed_product`. `fixture` mirrors the persisted product shape
 * (delivery_type, channels, pricing_options, …). Kept permissive — the spec
 * lets storyboards declare only the fields each test needs. */
export interface SeedProductParams {
  product_id: string;
  fixture: Record<string, unknown>;
}

export interface SeedPricingOptionParams {
  product_id: string;
  pricing_option_id: string;
  fixture: Record<string, unknown>;
}

export interface SeedCreativeParams {
  creative_id: string;
  fixture: Record<string, unknown>;
}

export interface SeedPlanParams {
  plan_id: string;
  fixture: Record<string, unknown>;
}

export interface SeedMediaBuyParams {
  media_buy_id: string;
  fixture: Record<string, unknown>;
}

export interface ForceCreativeStatusParams {
  creative_id: string;
  status: CreativeStatus;
  rejection_reason?: string;
}

export interface ForceAccountStatusParams {
  account_id: string;
  status: AccountStatus;
}

export interface ForceMediaBuyStatusParams {
  media_buy_id: string;
  status: MediaBuyStatus;
  rejection_reason?: string;
}

export interface ForceSessionStatusParams {
  session_id: string;
  status: 'complete' | 'terminated';
  termination_reason?: string;
}

export interface SimulateDeliveryParams {
  media_buy_id: string;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  reported_spend?: { amount: number; currency: string };
}

export interface SimulateBudgetSpendParams {
  account_id?: string;
  media_buy_id?: string;
  spend_percentage: number;
}

// ────────────────────────────────────────────────────────────
// Adapter function shapes
// ────────────────────────────────────────────────────────────

/** Seed adapters persist the fixture to the seller's data layer. Return
 * value is ignored — the helper builds the `previous_state` / `current_state`
 * envelope from its own idempotency cache. Throw {@link TestControllerError}
 * for typed errors (`INVALID_PARAMS`, `FORBIDDEN`). */
export type SeedAdapter<P> = (params: P, ctx: ComplyControllerContext) => Promise<void> | void;

/** Force adapters return a {@link StateTransitionSuccess}. Throw
 * `TestControllerError('INVALID_TRANSITION', msg, currentState)` when the
 * state machine disallows the transition. */
export type ForceAdapter<P> = (
  params: P,
  ctx: ComplyControllerContext
) => Promise<StateTransitionSuccess> | StateTransitionSuccess;

/** Simulate adapters return a {@link SimulationSuccess}. */
export type SimulateAdapter<P> = (
  params: P,
  ctx: ComplyControllerContext
) => Promise<SimulationSuccess> | SimulationSuccess;

// ────────────────────────────────────────────────────────────
// Controller config
// ────────────────────────────────────────────────────────────

export interface ComplyControllerConfig {
  /** Per-request gate. Return `false` to reject with `FORBIDDEN` — suitable
   * for tenants flagged as production, accounts not marked sandbox, or
   * missing sandbox headers. When omitted, every request is allowed.
   *
   * MCP tools/list visibility is controlled by *whether you call*
   * {@link ComplyController.register}. Wrap registration with your own
   * environment check if you need to hide the tool outside sandbox:
   *
   * ```ts
   * if (process.env.ADCP_SANDBOX === '1') controller.register(server);
   * ```
   *
   * Called for every request; the helper does NOT invoke adapters when the
   * gate returns false. Errors thrown from the gate are treated as denials
   * so a broken gate fails closed.
   */
  sandboxGate?: (input: Record<string, unknown>) => boolean | Promise<boolean>;

  /** Seed adapters. Each registered method advertises its scenario as
   * implemented; omitted methods return `UNKNOWN_SCENARIO` when called. */
  seed?: {
    product?: SeedAdapter<SeedProductParams>;
    pricing_option?: SeedAdapter<SeedPricingOptionParams>;
    creative?: SeedAdapter<SeedCreativeParams>;
    plan?: SeedAdapter<SeedPlanParams>;
    media_buy?: SeedAdapter<SeedMediaBuyParams>;
  };

  /** Force adapters (state transitions). */
  force?: {
    creative_status?: ForceAdapter<ForceCreativeStatusParams>;
    account_status?: ForceAdapter<ForceAccountStatusParams>;
    media_buy_status?: ForceAdapter<ForceMediaBuyStatusParams>;
    session_status?: ForceAdapter<ForceSessionStatusParams>;
  };

  /** Simulation adapters (synthetic delivery/budget data). */
  simulate?: {
    delivery?: SimulateAdapter<SimulateDeliveryParams>;
    budget_spend?: SimulateAdapter<SimulateBudgetSpendParams>;
  };

  /** Override the seed idempotency cache (e.g., to scope by tenant or
   * persist across restarts). Defaults to an unbounded in-memory cache. */
  seedCache?: SeedFixtureCache;
}

// ────────────────────────────────────────────────────────────
// Controller result
// ────────────────────────────────────────────────────────────

export interface ComplyControllerToolDefinition {
  name: 'comply_test_controller';
  description: string;
  inputSchema: typeof TOOL_INPUT_SHAPE;
}

export interface ComplyController {
  /** MCP tool definition — pass to `server.registerTool(name, { description, inputSchema }, handle)`
   * manually, or use {@link ComplyController.register} to do it for you. */
  readonly toolDefinition: ComplyControllerToolDefinition;

  /** Protocol-level handler. Returns a {@link ComplyTestControllerResponse}
   * without the MCP envelope — useful for A2A adaptation or custom transports. */
  handleRaw(input: Record<string, unknown>): Promise<ComplyTestControllerResponse>;

  /** MCP-envelope handler. Wraps {@link ComplyController.handleRaw} with
   * `content` + `structuredContent` + `isError`. */
  handle(input: Record<string, unknown>): Promise<McpToolResponse & { isError?: true }>;

  /** Register the tool on an `AdcpServer` or raw `McpServer`. Equivalent to
   * calling `server.registerTool(name, { description, inputSchema }, handle)`. */
  register(server: AdcpServer | McpServer): void;
}

// ────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────

function controllerError(code: ControllerError['error'], detail: string): ControllerError {
  return { success: false, error: code, error_detail: detail };
}

/** Build a {@link TestControllerStore} that delegates to the domain-grouped
 * adapters. Only methods for registered adapters are set, so
 * `handleTestControllerRequest` returns `UNKNOWN_SCENARIO` for the rest. */
function buildStore(config: ComplyControllerConfig, ctx: ComplyControllerContext): TestControllerStore {
  const store: TestControllerStore = {};
  const { seed, force, simulate } = config;

  if (seed?.product) {
    store.seedProduct = async (productId, fixture) => {
      await seed.product!({ product_id: productId, fixture: fixture ?? {} }, ctx);
    };
  }
  if (seed?.pricing_option) {
    store.seedPricingOption = async (productId, pricingOptionId, fixture) => {
      await seed.pricing_option!(
        { product_id: productId, pricing_option_id: pricingOptionId, fixture: fixture ?? {} },
        ctx
      );
    };
  }
  if (seed?.creative) {
    store.seedCreative = async (creativeId, fixture) => {
      await seed.creative!({ creative_id: creativeId, fixture: fixture ?? {} }, ctx);
    };
  }
  if (seed?.plan) {
    store.seedPlan = async (planId, fixture) => {
      await seed.plan!({ plan_id: planId, fixture: fixture ?? {} }, ctx);
    };
  }
  if (seed?.media_buy) {
    store.seedMediaBuy = async (mediaBuyId, fixture) => {
      await seed.media_buy!({ media_buy_id: mediaBuyId, fixture: fixture ?? {} }, ctx);
    };
  }

  if (force?.creative_status) {
    store.forceCreativeStatus = (creativeId, status, rejection_reason) =>
      Promise.resolve(force.creative_status!({ creative_id: creativeId, status, rejection_reason }, ctx));
  }
  if (force?.account_status) {
    store.forceAccountStatus = (accountId, status) =>
      Promise.resolve(force.account_status!({ account_id: accountId, status }, ctx));
  }
  if (force?.media_buy_status) {
    store.forceMediaBuyStatus = (mediaBuyId, status, rejection_reason) =>
      Promise.resolve(force.media_buy_status!({ media_buy_id: mediaBuyId, status, rejection_reason }, ctx));
  }
  if (force?.session_status) {
    store.forceSessionStatus = (sessionId, status, termination_reason) =>
      Promise.resolve(force.session_status!({ session_id: sessionId, status, termination_reason }, ctx));
  }

  if (simulate?.delivery) {
    store.simulateDelivery = (mediaBuyId, params) =>
      Promise.resolve(simulate.delivery!({ media_buy_id: mediaBuyId, ...params }, ctx));
  }
  if (simulate?.budget_spend) {
    store.simulateBudgetSpend = params => Promise.resolve(simulate.budget_spend!(params, ctx));
  }

  return store;
}

/** The set of force_* / simulate_* scenarios a config advertises via
 * `list_scenarios`. Seeds are intentionally NOT advertised per the spec. */
function advertisedScenarios(config: ComplyControllerConfig): ControllerScenario[] {
  const out: ControllerScenario[] = [];
  if (config.force?.creative_status) out.push(CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS);
  if (config.force?.account_status) out.push(CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS);
  if (config.force?.media_buy_status) out.push(CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS);
  if (config.force?.session_status) out.push(CONTROLLER_SCENARIOS.FORCE_SESSION_STATUS);
  if (config.simulate?.delivery) out.push(CONTROLLER_SCENARIOS.SIMULATE_DELIVERY);
  if (config.simulate?.budget_spend) out.push(CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND);
  return out;
}

/** Create a comply_test_controller scaffold from domain-grouped adapters. */
export function createComplyController(config: ComplyControllerConfig): ComplyController {
  const seedCache = config.seedCache ?? createSeedFixtureCache();
  const scenarios = advertisedScenarios(config);
  // Stable reference so factory answers list_scenarios without invoking
  // createStore — handleTestControllerRequest inspects the `scenarios` field.
  const factoryScenarios = Object.freeze([...scenarios]) as readonly ControllerScenario[];

  async function handleRaw(input: Record<string, unknown>): Promise<ComplyTestControllerResponse> {
    // `list_scenarios` is a capability probe — answer it without consulting
    // the gate so buyer tooling can distinguish "controller exists but
    // locked" from "controller missing entirely". State-mutating scenarios
    // still go through the gate below.
    const isListScenariosProbe = input.scenario === 'list_scenarios';

    if (config.sandboxGate && !isListScenariosProbe) {
      let allowed: unknown;
      try {
        allowed = await config.sandboxGate(input);
      } catch (err) {
        // Don't leak gate-internal errors. Treat as denial — matches how a
        // sandbox would fail closed if its auth layer threw.
        void err;
        return controllerError('FORBIDDEN', 'Sandbox gate check failed');
      }
      // Strict equality: anything that is not literally `true` is a denial.
      // Guards against gates that accidentally return a reason string, a
      // number, or a truthy object.
      if (allowed !== true) {
        return controllerError(
          'FORBIDDEN',
          'comply_test_controller is disabled in this environment (non-sandbox or gate denied)'
        );
      }
    }

    const ctx: ComplyControllerContext = { input };
    const store = buildStore(config, ctx);

    return handleTestControllerRequest({ scenarios: factoryScenarios, createStore: () => store }, input, { seedCache });
  }

  async function handle(input: Record<string, unknown>) {
    return toMcpResponse(await handleRaw(input));
  }

  // Shallow-copy the shape so a caller who mutates toolDefinition.inputSchema
  // doesn't poison subsequent registrations. Zod schema values inside are
  // themselves immutable, so a one-level copy is enough.
  const toolDefinition: ComplyControllerToolDefinition = Object.freeze({
    name: 'comply_test_controller',
    description: 'Triggers seller-side state transitions for compliance testing. Sandbox only.',
    inputSchema: { ...TOOL_INPUT_SHAPE },
  });

  // Per-controller latch so the "ungated controller" warning fires once even
  // when serve() invokes the factory (and therefore register) per request.
  let hasWarnedOnRegister = false;

  function register(server: AdcpServer | McpServer): void {
    // Loud warning when the tool is about to be exposed without any explicit
    // gate. Sellers who intentionally gate at the transport layer can silence
    // this by setting ADCP_SANDBOX=1 (or ADCP_COMPLY_CONTROLLER_UNGATED=1 to
    // opt out entirely). Prevents silent fail-open misuse without breaking
    // the API's "gate is optional" shape.
    if (
      !hasWarnedOnRegister &&
      !config.sandboxGate &&
      process.env.ADCP_SANDBOX !== '1' &&
      process.env.ADCP_COMPLY_CONTROLLER_UNGATED !== '1'
    ) {
      hasWarnedOnRegister = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[comply_test_controller] Registered with no sandboxGate and no ' +
          'ADCP_SANDBOX / ADCP_COMPLY_CONTROLLER_UNGATED env flag. The tool ' +
          'will accept every request — only correct if your transport layer ' +
          'enforces sandbox isolation. See createComplyController docs.'
      );
    }
    const mcp = getSdkServer(server as AdcpServer) ?? (server as McpServer);
    mcp.registerTool(
      toolDefinition.name,
      {
        description: toolDefinition.description,
        inputSchema: toolDefinition.inputSchema,
      },
      (async (input: Record<string, unknown>) => handle(input)) as Parameters<typeof mcp.registerTool>[2]
    );
  }

  return { toolDefinition, handleRaw, handle, register };
}
