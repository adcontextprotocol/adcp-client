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
 *     `SeedSuccess` with `message: "Fixture re-seeded (equivalent)"`;
 *     divergent fixture = `INVALID_PARAMS`)
 *   - Per-request sandbox gating, plus fail-closed direct registration when
 *     that gate is omitted
 *
 * The helper does NOT own the state machine. Transition enforcement lives
 * inside your adapters so production and compliance testing share one source
 * of truth — throw `TestControllerError('INVALID_TRANSITION', …)` from the
 * adapter when a transition is disallowed.
 *
 * For custom MCP wrappers that need AsyncLocalStorage, sandbox gating at the
 * transport layer, or a session-backed store factory, compose
 * `handleTestControllerRequest`, `toMcpResponse`, and `TOOL_INPUT_SHAPE` from
 * `@adcp/sdk/server` directly — the flat-store surface documented there.
 *
 * @example
 * ```ts
 * import { createComplyController } from '@adcp/sdk/testing';
 *
 * const controller = createComplyController({
 *   // Server-controlled deployment state; never trust a field in `input`.
 *   sandboxGate: () => process.env.ADCP_SANDBOX === '1',
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
import type { ZodTypeAny } from 'zod';
import {
  CONTROLLER_SCENARIOS,
  DISCOVERY_ARM_SCENARIOS,
  TOOL_INPUT_SHAPE,
  createSeedFixtureCache,
  handleTestControllerRequest,
  toMcpResponse,
  type ControllerScenario,
  type SeedFixtureCache,
  type TestControllerStore,
  type UpstreamTrafficSuccessResponse,
} from '../server/test-controller';
import { getSdkServer, type AdcpServer } from '../server/adcp-server';
import type {
  ComplyTestControllerResponse,
  ControllerError,
  ForcedDirectiveSuccess,
  ProvenanceAuditObservationsSuccess,
  SimulationSuccess,
  StateTransitionSuccess,
} from '../types/tools.generated';
import type {
  AccountStatus,
  AudienceStatus,
  CatalogItemStatus,
  CreativeStatus,
  MediaBuyStatus,
} from '../types/core.generated';
import type { Account, ResolvedAuthInfo } from '../server/decisioning/account';
import type { BuyerAgent, BuyerAgentBillingMode, BuyerAgentStatus } from '../server/decisioning/buyer-agent';
import type { TaskRegistryScope } from '../server/decisioning/runtime/task-registry';
import type { McpToolResponse } from '../server/responses';

// ────────────────────────────────────────────────────────────
// Adapter param shapes
// ────────────────────────────────────────────────────────────

/** Common second argument every adapter receives: the raw tool input so
 * adapters can read `context.session_id`, `ext`, or vendor-specific fields. */
export interface ComplyControllerContext {
  /** The tool input as received over the wire, pre-validation. */
  input: Record<string, unknown>;
  /**
   * Framework-resolved target account. Never derived from `input.account`.
   * This is a trusted server-side reference; adapters must not mutate it.
   */
  readonly account?: Readonly<Account>;
  /** Authenticated buyer agent used while resolving the target account. */
  readonly agent?: Readonly<BuyerAgent>;
  /**
   * Trusted transport authentication context supplied by the server framework.
   * It may contain credentials or claims; do not mutate, log, or persist it wholesale.
   */
  readonly authInfo?: Readonly<ResolvedAuthInfo>;
  /** Trusted account/principal scope for task-oriented controller adapters. */
  readonly taskScope?: Readonly<TaskRegistryScope>;
}

/** @internal Trusted authority supplied only by the decisioning framework. */
export interface ResolvedComplyControllerAuthority {
  readonly account?: Readonly<Account>;
  readonly agent?: Readonly<BuyerAgent>;
  readonly authInfo?: Readonly<ResolvedAuthInfo>;
  readonly taskScope?: Readonly<TaskRegistryScope>;
}

/** Params for `seed_product`. `fixture` mirrors the persisted product shape
 * (delivery_type, channels, pricing_options, …). Kept permissive — the spec
 * lets storyboards declare only the fields each test needs. */
export interface SeedProductParams {
  product_id: string;
  fixture: Record<string, unknown>;
}

/** Params for `seed_account`. `fixture` mirrors the persisted account shape
 * (name, status, billing/rate-card metadata, authorization, …). Kept
 * permissive because storyboards declare only the account fields they need. */
export interface SeedAccountParams {
  account_id: string;
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

export interface SeedCreativeFormatParams {
  format_id: string;
  fixture: Record<string, unknown>;
}

export interface SeedMeasurementCatalogParams {
  vendor: unknown;
  metrics: unknown;
  fixture: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SeedBuyerAgentParams {
  agent_url: string;
  display_name?: string;
  status?: BuyerAgentStatus;
  billing_capabilities?: BuyerAgentBillingMode[];
  default_account_terms?: BuyerAgent['default_account_terms'];
  allowed_brands?: string[];
  aliases?: string[];
  sandbox_only?: boolean;
  [key: string]: unknown;
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

export interface ForceCreateMediaBuyArmParams {
  arm: 'submitted' | 'input-required';
  task_id?: string;
  message?: string;
}

export interface ForceGetProductsArmParams {
  arm: 'submitted';
  task_id: string;
  message?: string;
}

export interface ForceGetSignalsArmParams {
  arm: 'submitted';
  task_id: string;
  message?: string;
}

export interface ForceTaskCompletionParams {
  task_id: string;
  result: Record<string, unknown>;
}

export interface ForceCreativePurgeParams {
  creative_id: string;
  purge_kind?: 'soft' | 'hard';
  reason_code?: string;
  reason_detail?: string;
  [key: string]: unknown;
}

export interface ForceUpstreamUnavailableParams {
  tool: string;
  upstream_name?: string;
}

/**
 * Params for `force_audience_status` (extension scenario; issue #1819).
 * `status` is typed against the spec-shipped `AudienceStatus`; offline
 * values (e.g. `suspended` for adcp#2860's impairment storyboard) flow
 * through automatically once the spec ships them and codegen reruns.
 */
export interface ForceAudienceStatusParams {
  audience_id: string;
  status: AudienceStatus;
  reason?: string;
}

/** Params for `force_catalog_item_status` (extension scenario; issue #1819). */
export interface ForceCatalogItemStatusParams {
  catalog_item_id: string;
  status: CatalogItemStatus;
  reason?: string;
}

export interface SimulateDeliveryParams {
  media_buy_id: string;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  reported_spend?: { amount: number; currency: string };
  [key: string]: unknown;
}

export interface SimulateBudgetSpendParams {
  account_id?: string;
  media_buy_id?: string;
  spend_percentage: number;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────
// Adapter function shapes
// ────────────────────────────────────────────────────────────

/** Seed adapters persist the fixture to the seller's data layer. Return
 * value is ignored — the helper builds the `SeedSuccess` envelope (the
 * 3.0.1+ message-only seed arm) from its own idempotency cache. Throw
 * {@link TestControllerError} for typed errors (`INVALID_PARAMS`,
 * `FORBIDDEN`). */
export type SeedAdapter<P> = (params: P, ctx: ComplyControllerContext) => Promise<void> | void;

/** Force adapters return a {@link StateTransitionSuccess}. Throw
 * `TestControllerError('INVALID_TRANSITION', msg, currentState)` when the
 * state machine disallows the transition. */
export type ForceAdapter<P> = (
  params: P,
  ctx: ComplyControllerContext
) => Promise<StateTransitionSuccess> | StateTransitionSuccess;

/** Directive adapters return a {@link ForcedDirectiveSuccess} (pre-registration
 * of a pending directive, not a state-machine transition). Used for
 * `create_media_buy_arm` which acknowledges the registered arm rather than
 * recording a `previous_state` / `current_state` transition. */
export type DirectiveAdapter<P> = (
  params: P,
  ctx: ComplyControllerContext
) => Promise<ForcedDirectiveSuccess> | ForcedDirectiveSuccess;

/** Simulate adapters return a {@link SimulationSuccess}. */
export type SimulateAdapter<P> = (
  params: P,
  ctx: ComplyControllerContext
) => Promise<SimulationSuccess> | SimulationSuccess;

/** Params for the `query_upstream_traffic` extension scenario (spec PR
 * adcontextprotocol/adcp#3816). All fields optional; the recorder
 * filters by these. */
export interface QueryUpstreamTrafficParams {
  since_timestamp?: string;
  endpoint_pattern?: string;
  limit?: number;
  attestation_mode?: 'raw' | 'digest';
  identifier_value_digests?: string[];
}

/** Adapter for the `query_upstream_traffic` extension scenario. Returns
 * the recorded upstream HTTP calls produced during the current
 * storyboard step — the runner consults this for `check: upstream_traffic`
 * validations. Adopters typically delegate to the reference recorder
 * middleware shipped at `@adcp/sdk/upstream-recorder`:
 *
 * ```ts
 * complyTest: {
 *   queryUpstreamTraffic: (params, _ctx) => {
 *     const result = recorder.query({
 *       principal: RECORDER_PRINCIPAL,
 *       ...(params.since_timestamp !== undefined && { sinceTimestamp: params.since_timestamp }),
 *       ...(params.endpoint_pattern !== undefined && { endpointPattern: params.endpoint_pattern }),
 *       ...(params.limit !== undefined && { limit: params.limit }),
 *       ...(params.attestation_mode !== undefined && { attestationMode: params.attestation_mode }),
 *       ...(params.identifier_value_digests !== undefined && {
 *         identifierValueDigests: params.identifier_value_digests,
 *       }),
 *     });
 *     return toQueryUpstreamTrafficResponse(result);
 *   },
 * }
 * ```
 *
 * The principal MUST match between record-time (`runWithPrincipal`) and
 * query-time, or the recorder returns zero rows per cross-tenant
 * isolation. */
export type QueryUpstreamTrafficAdapter = (
  params: QueryUpstreamTrafficParams,
  ctx: ComplyControllerContext
) => Promise<UpstreamTrafficSuccessResponse> | UpstreamTrafficSuccessResponse;

export interface QueryProvenanceAuditObservationsParams {
  creative_id: string;
  [key: string]: unknown;
}

/** Adapter for `query_provenance_audit_observations`. Returns sandbox-only
 * audit observations recorded for the creative under test. */
export type QueryProvenanceAuditObservationsAdapter = (
  params: QueryProvenanceAuditObservationsParams,
  ctx: ComplyControllerContext
) => Promise<ProvenanceAuditObservationsSuccess> | ProvenanceAuditObservationsSuccess;

// ────────────────────────────────────────────────────────────
// Controller config
// ────────────────────────────────────────────────────────────

export interface ComplyControllerConfig {
  /** Per-request gate. Return `false` to reject with `FORBIDDEN` — suitable
   * for tenants flagged as production, accounts not marked sandbox, or
   * missing sandbox headers. When omitted, direct `register()` calls fail
   * closed unless the process is explicitly acknowledged as an ungated test
   * or development environment (see below).
   *
   * The callback receives buyer-supplied tool arguments only. Do not treat
   * any field in `input` as authentication or resolved account state. Close
   * over trusted server-side deployment/auth state, or use
   * `createAdcpServerFromPlatform(platform, { complyTest })` for its resolved-account
   * authority gate.
   *
   * MCP tools/list visibility is controlled by *whether you call*
   * {@link ComplyController.register}. Wrap registration with your own
   * environment check if you need to hide the tool outside sandbox. An
   * ungated registration is accepted only when `NODE_ENV` is `test` or
   * `development` AND `ADCP_COMPLY_CONTROLLER_UNGATED=1`:
   *
   * ```ts
   * if (process.env.NODE_ENV === 'test') {
   *   process.env.ADCP_COMPLY_CONTROLLER_UNGATED = '1';
   *   controller.register(server);
   * }
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
    account?: SeedAdapter<SeedAccountParams>;
    product?: SeedAdapter<SeedProductParams>;
    pricing_option?: SeedAdapter<SeedPricingOptionParams>;
    creative?: SeedAdapter<SeedCreativeParams>;
    plan?: SeedAdapter<SeedPlanParams>;
    media_buy?: SeedAdapter<SeedMediaBuyParams>;
    creative_format?: SeedAdapter<SeedCreativeFormatParams>;
    measurement_catalog?: SeedAdapter<SeedMeasurementCatalogParams>;
    buyer_agent?: SeedAdapter<SeedBuyerAgentParams>;
  };

  /** Force adapters (state transitions and directives). */
  force?: {
    creative_status?: ForceAdapter<ForceCreativeStatusParams>;
    account_status?: ForceAdapter<ForceAccountStatusParams>;
    media_buy_status?: ForceAdapter<ForceMediaBuyStatusParams>;
    session_status?: ForceAdapter<ForceSessionStatusParams>;
    /** Register a directive shaping the next `create_media_buy` arm. Consumed
     * on the next call. `arm: 'submitted'` requires `task_id`. */
    create_media_buy_arm?: DirectiveAdapter<ForceCreateMediaBuyArmParams>;
    /** Register a directive shaping the next `get_products` async arm. Extension
     * scenario for async discovery storyboards (adcp#5342). */
    get_products_arm?: DirectiveAdapter<ForceGetProductsArmParams>;
    /** Register a directive shaping the next `get_signals` submitted arm. Extension
     * scenario for async discovery storyboards (adcp#5342). */
    get_signals_arm?: DirectiveAdapter<ForceGetSignalsArmParams>;
    /** Transition an in-flight task to `completed` with the given result
     * payload. The seller delivers `result` to the buyer's push-notification
     * URL per the AdCP 3.0 async completion path. */
    task_completion?: ForceAdapter<ForceTaskCompletionParams>;
    /** Destroy or tombstone a sandbox creative so lifecycle webhooks can be tested. */
    creative_purge?: ForceAdapter<ForceCreativePurgeParams>;
    /** Mark a named upstream dependency unreachable for stale-cache testing. */
    upstream_unavailable?: ForceAdapter<ForceUpstreamUnavailableParams>;
    /** Transition a synced audience to a matching status. Backs the
     * `impairment.coherence` audience inverse-rule traversal (issue #1819).
     * Advertised as `force_audience_status`. */
    audience_status?: ForceAdapter<ForceAudienceStatusParams>;
    /** Transition a single catalog item to a review status. Backs the
     * catalog-side `impairment.coherence` traversal (issue #1819).
     * Advertised as `force_catalog_item_status`. */
    catalog_item_status?: ForceAdapter<ForceCatalogItemStatusParams>;
  };

  /** Simulation adapters (synthetic delivery/budget data). */
  simulate?: {
    delivery?: SimulateAdapter<SimulateDeliveryParams>;
    budget_spend?: SimulateAdapter<SimulateBudgetSpendParams>;
  };

  /**
   * `query_upstream_traffic` adapter (spec PR adcontextprotocol/adcp#3816).
   * Returns the recorded upstream HTTP calls produced during the current
   * storyboard step so the runner can grade `check: upstream_traffic`
   * validations. Adopters typically wire the reference recorder from
   * `@adcp/sdk/upstream-recorder`. When omitted, the scenario reports as
   * `not_applicable` per the runner's normal capability discovery.
   */
  queryUpstreamTraffic?: QueryUpstreamTrafficAdapter;

  /**
   * `query_provenance_audit_observations` adapter. When omitted, provenance
   * audit-observation storyboards grade as not applicable after scenario
   * discovery.
   */
  queryProvenanceAuditObservations?: QueryProvenanceAuditObservationsAdapter;

  /** Override the seed idempotency cache (e.g., to scope by tenant or
   * persist across restarts). Defaults to an unbounded in-memory cache. */
  seedCache?: SeedFixtureCache;

  /**
   * Extra Zod fields to merge into the canonical `comply_test_controller`
   * input schema. Use this when a custom wrapper carries a tenant or account
   * reference in a top-level field that the spec-canonical
   * {@link TOOL_INPUT_SHAPE} doesn't include. Treat such fields only as
   * identifiers for trusted server-side resolution; never use their contents
   * directly as sandbox authority.
   * Keys override canonical fields if there's a name collision; the
   * resulting shape is what the framework passes to
   * `mcp.registerTool(..., { inputSchema })` at registration.
   *
   * Mirrors the documented `{ ...TOOL_INPUT_SHAPE, account: ... }`
   * pattern from `test-controller.ts` so adopters routed through
   * `createAdcpServerFromPlatform(platform, { complyTest })` get the same
   * extension seam as adopters wiring `registerTestController` directly.
   *
   * Storyboard fixtures that send a top-level `account` or `brand`
   * (rather than `context.account` / `context.brand`) are the canonical
   * cases for this option — both are stripped by the spec-canonical
   * shape.
   *
   * @example
   * ```ts
   * import { z } from 'zod';
   *
   * complyTest: {
   *   inputSchema: {
   *     account: z.object({ account_id: z.string() }).passthrough().optional(),
   *     brand: z.object({ domain: z.string() }).passthrough().optional(),
   *   },
   *   force: { ... },
   * }
   * ```
   */
  inputSchema?: Record<string, ZodTypeAny>;
}

// ────────────────────────────────────────────────────────────
// Controller result
// ────────────────────────────────────────────────────────────

export interface ComplyControllerToolDefinition {
  name: 'comply_test_controller';
  description: string;
  /**
   * The merged Zod input shape — canonical {@link TOOL_INPUT_SHAPE}
   * fields plus any adopter-supplied {@link ComplyControllerConfig.inputSchema}
   * extensions. Adopter keys win on collision. Pass directly to
   * `server.registerTool(name, { inputSchema }, handler)` when wiring
   * the controller manually.
   */
  inputSchema: typeof TOOL_INPUT_SHAPE & Record<string, ZodTypeAny>;
}

export interface ComplyController {
  /** MCP tool definition — pass to `server.registerTool(name, { description, inputSchema }, handle)`
   * manually only when your wrapper owns an equivalent authorization gate,
   * or use {@link ComplyController.register} to retain the built-in
   * fail-closed registration guard. */
  readonly toolDefinition: ComplyControllerToolDefinition;

  /** Protocol-level handler. Returns a {@link ComplyTestControllerResponse}
   * without the MCP envelope — useful for A2A adaptation or custom transports. */
  handleRaw(input: Record<string, unknown>): Promise<ComplyTestControllerResponse>;

  /** MCP-envelope handler. Wraps {@link ComplyController.handleRaw} with
   * `content` + `structuredContent` + `isError`. */
  handle(input: Record<string, unknown>): Promise<McpToolResponse & { isError?: true }>;

  /** Register the tool on an `AdcpServer` or raw `McpServer`. Refuses an
   * omitted `sandboxGate` unless this is an explicitly acknowledged local
   * test/development harness. */
  register(server: AdcpServer | McpServer): void;
}

// ────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────

function controllerError(code: ControllerError['error'], detail: string): ComplyTestControllerResponse {
  // AdCP 3.1.0-beta.2+: envelope `status` is REQUIRED on every response,
  // including the error arms of a discriminated controller response.
  return { status: 'failed', success: false, error: code, error_detail: detail } as ComplyTestControllerResponse;
}

/** Build a {@link TestControllerStore} that delegates to the domain-grouped
 * adapters. Only methods for registered adapters are set, so
 * `handleTestControllerRequest` returns `UNKNOWN_SCENARIO` for the rest. */
function buildStore(config: ComplyControllerConfig, ctx: ComplyControllerContext): TestControllerStore {
  const store: TestControllerStore = {};
  const { seed, force, simulate, queryUpstreamTraffic, queryProvenanceAuditObservations } = config;

  if (seed?.account) {
    store.seedAccount = async (accountId, fixture) => {
      await seed.account!({ account_id: accountId, fixture: fixture ?? {} }, ctx);
    };
  }
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
  if (seed?.creative_format) {
    store.seedCreativeFormat = async (formatId, fixture) => {
      await seed.creative_format!({ format_id: formatId, fixture: fixture ?? {} }, ctx);
    };
  }
  if (seed?.measurement_catalog) {
    store.seedMeasurementCatalog = async params => {
      await seed.measurement_catalog!(
        {
          ...params,
          vendor: params.vendor,
          metrics: params.metrics,
          fixture: params.fixture ?? {},
        },
        ctx
      );
    };
  }
  if (seed?.buyer_agent) {
    store.seedBuyerAgent = async (agentUrl, fixture) => {
      const { agent_url: _ignored, ...safeFixture } = fixture ?? {};
      void _ignored;
      await seed.buyer_agent!({ ...safeFixture, agent_url: agentUrl }, ctx);
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
  if (force?.create_media_buy_arm) {
    store.forceCreateMediaBuyArm = params => Promise.resolve(force.create_media_buy_arm!(params, ctx));
  }
  if (force?.get_products_arm) {
    store.forceGetProductsArm = params => Promise.resolve(force.get_products_arm!(params, ctx));
  }
  if (force?.get_signals_arm) {
    store.forceGetSignalsArm = params => Promise.resolve(force.get_signals_arm!(params, ctx));
  }
  if (force?.task_completion) {
    store.forceTaskCompletion = (taskId, result) =>
      Promise.resolve(force.task_completion!({ task_id: taskId, result }, ctx));
  }
  if (force?.creative_purge) {
    store.forceCreativePurge = (creativeId, params) =>
      Promise.resolve(force.creative_purge!({ creative_id: creativeId, ...params }, ctx));
  }
  if (force?.upstream_unavailable) {
    store.forceUpstreamUnavailable = params => Promise.resolve(force.upstream_unavailable!(params, ctx));
  }
  if (force?.audience_status) {
    store.forceAudienceStatus = (audienceId, status, reason) =>
      Promise.resolve(force.audience_status!({ audience_id: audienceId, status, reason }, ctx));
  }
  if (force?.catalog_item_status) {
    store.forceCatalogItemStatus = (itemId, status, reason) =>
      Promise.resolve(force.catalog_item_status!({ catalog_item_id: itemId, status, reason }, ctx));
  }

  if (simulate?.delivery) {
    store.simulateDelivery = (mediaBuyId, params) =>
      Promise.resolve(simulate.delivery!({ media_buy_id: mediaBuyId, ...params }, ctx));
  }
  if (simulate?.budget_spend) {
    store.simulateBudgetSpend = params => Promise.resolve(simulate.budget_spend!(params, ctx));
  }

  if (queryUpstreamTraffic) {
    store.queryUpstreamTraffic = params => Promise.resolve(queryUpstreamTraffic(params, ctx));
  }
  if (queryProvenanceAuditObservations) {
    store.queryProvenanceAuditObservations = params => Promise.resolve(queryProvenanceAuditObservations(params, ctx));
  }

  return store;
}

/** The set of canonical scenarios a config advertises via `list_scenarios`.
 * `list_scenarios` itself is implicit and excluded. */
function advertisedScenarios(config: ComplyControllerConfig): ControllerScenario[] {
  const out: ControllerScenario[] = [];
  if (config.force?.creative_status) out.push(CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS);
  if (config.force?.account_status) out.push(CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS);
  if (config.force?.media_buy_status) out.push(CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS);
  if (config.force?.session_status) out.push(CONTROLLER_SCENARIOS.FORCE_SESSION_STATUS);
  if (config.force?.create_media_buy_arm) out.push(CONTROLLER_SCENARIOS.FORCE_CREATE_MEDIA_BUY_ARM);
  if (config.force?.get_products_arm) out.push(DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM as ControllerScenario);
  if (config.force?.get_signals_arm) out.push(DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM as ControllerScenario);
  if (config.force?.task_completion) out.push(CONTROLLER_SCENARIOS.FORCE_TASK_COMPLETION);
  if (config.force?.creative_purge) out.push(CONTROLLER_SCENARIOS.FORCE_CREATIVE_PURGE);
  if (config.simulate?.delivery) out.push(CONTROLLER_SCENARIOS.SIMULATE_DELIVERY);
  if (config.simulate?.budget_spend) out.push(CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND);
  if (config.seed?.account) out.push('seed_account' as unknown as ControllerScenario);
  if (config.seed?.product) out.push('seed_product');
  if (config.seed?.pricing_option) out.push('seed_pricing_option');
  if (config.seed?.creative) out.push('seed_creative');
  if (config.seed?.plan) out.push('seed_plan');
  if (config.seed?.media_buy) out.push('seed_media_buy');
  if (config.seed?.creative_format) out.push('seed_creative_format');
  if (config.seed?.measurement_catalog) out.push('seed_measurement_catalog');
  // Extension scenarios not yet in the schema cache's `ControllerScenario`
  // enum are still accepted by the dispatcher under the open-extension
  // `TOOL_INPUT_SHAPE.scenario: z.string()` pattern.
  if (config.seed?.buyer_agent) out.push('seed_buyer_agent' as unknown as ControllerScenario);
  if (config.force?.audience_status) out.push('force_audience_status' as unknown as ControllerScenario);
  if (config.force?.catalog_item_status) out.push('force_catalog_item_status' as unknown as ControllerScenario);
  if (config.queryUpstreamTraffic) out.push(CONTROLLER_SCENARIOS.QUERY_UPSTREAM_TRAFFIC);
  if (config.queryProvenanceAuditObservations) {
    out.push(CONTROLLER_SCENARIOS.QUERY_PROVENANCE_AUDIT_OBSERVATIONS);
  }
  if (config.force?.upstream_unavailable) out.push(CONTROLLER_SCENARIOS.FORCE_UPSTREAM_UNAVAILABLE);
  return out;
}

type ResolvedContextHandler = (
  input: Record<string, unknown>,
  authority: ResolvedComplyControllerAuthority
) => Promise<ComplyTestControllerResponse>;

// Keep the authority-bearing entry point off the public ComplyController
// object. Custom transports retain the existing raw-input-only API, while the
// decisioning framework can thread the authority it already resolved without
// making a second lookup or accepting authority from request extension fields.
const resolvedContextHandlers = new WeakMap<ComplyController, ResolvedContextHandler>();

/** @internal Decisioning-framework bridge; not exported from the package barrel. */
export async function _handleComplyControllerWithResolvedAuthority(
  controller: ComplyController,
  input: Record<string, unknown>,
  authority: ResolvedComplyControllerAuthority
): Promise<McpToolResponse & { isError?: true }> {
  const handler = resolvedContextHandlers.get(controller);
  if (!handler) throw new TypeError('ComplyController was not created by createComplyController');
  return toMcpResponse(await handler(input, authority));
}

/** Create a comply_test_controller scaffold from domain-grouped adapters. */
export function createComplyController(config: ComplyControllerConfig): ComplyController {
  const seedCache = config.seedCache ?? createSeedFixtureCache();
  const scenarios = advertisedScenarios(config);
  // Stable reference so factory answers list_scenarios without invoking
  // createStore — handleTestControllerRequest inspects the `scenarios` field.
  const factoryScenarios = Object.freeze([...scenarios]) as readonly ControllerScenario[];

  async function handleRawWithResolvedAuthority(
    input: Record<string, unknown>,
    authority: ResolvedComplyControllerAuthority
  ): Promise<ComplyTestControllerResponse> {
    const inputCtx = input.context;
    // Echoes input.context on FORBIDDEN early-returns (sandboxGate denial/throw)
    // that bypass handleTestControllerRequest. The delegated call at the end of
    // this function already echoes context internally — addCtx is a no-op there.
    const addCtx = (r: ComplyTestControllerResponse): ComplyTestControllerResponse =>
      inputCtx !== undefined && typeof inputCtx === 'object' && inputCtx !== null && r.context === undefined
        ? ({ ...r, context: inputCtx } as ComplyTestControllerResponse)
        : r;

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
        return addCtx(controllerError('FORBIDDEN', 'Sandbox gate check failed'));
      }
      // Strict equality: anything that is not literally `true` is a denial.
      // Guards against gates that accidentally return a reason string, a
      // number, or a truthy object.
      if (allowed !== true) {
        return addCtx(
          controllerError(
            'FORBIDDEN',
            'comply_test_controller is disabled in this environment (non-sandbox or gate denied)'
          )
        );
      }
    }

    // Keep the pre-existing mutable `input` slot for source/runtime
    // compatibility while making trusted authority slots non-overridable even
    // for JavaScript adapters. The authority objects themselves are the exact
    // framework-resolved references and must be treated as readonly.
    const ctx: ComplyControllerContext = { input };
    for (const [key, value] of Object.entries(authority)) {
      if (value === undefined) continue;
      Object.defineProperty(ctx, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    const store = buildStore(config, ctx);

    const resolvedAccountId = authority.account?.id;
    return handleTestControllerRequest({ scenarios: factoryScenarios, createStore: () => store }, input, {
      seedCache,
      ...(resolvedAccountId !== undefined && {
        seedScopePrefix: `resolved_account:${resolvedAccountId.length}:${resolvedAccountId}`,
      }),
    });
  }

  async function handleRaw(input: Record<string, unknown>): Promise<ComplyTestControllerResponse> {
    return handleRawWithResolvedAuthority(input, {});
  }

  async function handle(input: Record<string, unknown>) {
    return toMcpResponse(await handleRaw(input));
  }

  // Shallow-copy the canonical shape and overlay any adopter-supplied
  // extension fields. Spread order is canonical-then-extensions so a
  // collision (e.g., adopter redefines `params`) lets the adopter win.
  // Zod schema values are themselves immutable, so a one-level copy is
  // enough to keep callers from poisoning subsequent registrations.
  const toolDefinition: ComplyControllerToolDefinition = Object.freeze({
    name: 'comply_test_controller',
    description: 'Triggers seller-side state transitions for compliance testing. Sandbox only.',
    inputSchema: { ...TOOL_INPUT_SHAPE, ...(config.inputSchema ?? {}) },
  });

  function register(server: AdcpServer | McpServer): void {
    // An env flag must never silently turn into a production authorization
    // decision. Keep the optional config shape for compatibility, but refuse
    // to expose an ungated controller unless a non-production process also
    // carries the dedicated explicit acknowledgement.
    if (!config.sandboxGate) {
      const isNonProduction = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
      const explicitlyAcknowledged = process.env.ADCP_COMPLY_CONTROLLER_UNGATED === '1';
      if (!isNonProduction || !explicitlyAcknowledged) {
        throw new Error(
          'createComplyController.register: refusing to register comply_test_controller without sandboxGate. ' +
            'Ungated registration is allowed only when NODE_ENV is test/development and ' +
            'ADCP_COMPLY_CONTROLLER_UNGATED=1 is set explicitly.'
        );
      }
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

  const controller = { toolDefinition, handleRaw, handle, register };
  resolvedContextHandlers.set(controller, handleRawWithResolvedAuthority);
  return controller;
}
