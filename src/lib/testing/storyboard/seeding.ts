/**
 * Pre-flight `comply_test_controller` seeding.
 *
 * Spec: adcontextprotocol/adcp#2585 (fixtures block + `controller_seeding`
 * flag) + adcontextprotocol/adcp#2584 (seed_* scenarios on
 * `comply_test_controller`). Storyboards such as `sales_non_guaranteed`,
 * `creative_ad_server`, `governance_delivery_monitor`,
 * `media_buy_governance_escalation`, and `governance_spend_authority`
 * reference fixture IDs (product_ids, pricing_option_ids, creative_ids,
 * plan_ids, media_buy_ids) that the seller must already hold before the
 * buyer-side flow runs. This module fires the `seed_*` scenarios derived
 * from the storyboard's top-level `fixtures:` block before the first real
 * phase, so the seller's buyer-agent ledger and catalog are populated ahead
 * of any `sync_accounts` / `create_media_buy` / `sync_creatives` / etc. call
 * that would otherwise fail or route through the wrong commercial-state gate.
 *
 * Failures here surface as a dedicated synthetic phase (`__controller_seeding__`)
 * so an implementor reading the report can distinguish "setup broke" from
 * "buyer did something wrong" — the runner short-circuits the rest of the
 * phases on any seed failure, emitting a cascade skip with reason
 * `controller_seeding_failed`.
 */

import { resolveAccount, resolveBrand, validateResponseSchema, type TestClient } from '../client';
import { getValidator } from '../../validation/schema-loader';
import { ADCP_VERSION } from '../../version';
import { injectLegacyEnvelopeStatus } from '../../utils/envelope-status-compat';
import { callControllerRaw } from '../test-controller';
import { executeStoryboardTask } from './task-map';
import {
  buildFixtureResolutionSpecs,
  applyFixtureBindingsToRequest,
  FixtureBindingRegistry,
  matchesFixtureRequirements,
  matchFixtureRequirementsWithWitness,
  type FixtureResolutionSpec,
} from './fixture-resolution';
import { readCollectionWitness, type CollectionSelectionWitness } from './collection-selection';
import { resolvePath } from './path';
import { redactSecrets } from '../../utils/redact-secrets';
import type {
  ContextProvenanceEntry,
  FixtureResolutionAttempt,
  RunnerRequestRecord,
  RunnerResponseRecord,
  FixtureResolutionRecord,
  Storyboard,
  StoryboardContext,
  StoryboardFixtures,
  StoryboardPhaseResult,
  StoryboardRunOptions,
  StoryboardStepResult,
} from './types';

/** Synthetic phase id used in `StoryboardResult.phases[]` for the seed pass. */
export const CONTROLLER_SEEDING_PHASE_ID = '__controller_seeding__';

/** Seed scenario names. Kept local — the server-side `SEED_SCENARIOS`
 * constant from `src/lib/server/test-controller.ts` is authoritative, but
 * importing it here would cross the testing ⇄ server module boundary. */
type SeedScenario =
  | 'seed_account'
  | 'seed_product'
  | 'seed_pricing_option'
  | 'seed_creative_format'
  | 'seed_creative'
  | 'seed_plan'
  | 'seed_media_buy';
type BuyerAgentSeedScenario = 'seed_buyer_agent';

export interface SeedCall {
  step_id: string;
  title: string;
  scenario: SeedScenario | BuyerAgentSeedScenario;
  params: Record<string, unknown>;
  /** Authoring error (e.g. missing required id). When set, the call fails at
   * build time — no controller request is issued. */
  authoring_error?: string;
}

/**
 * Translate a storyboard `fixtures:` block into an ordered list of seed
 * calls. Each entry's id field(s) are lifted into the scenario params; every
 * remaining field rides in `params.fixture` verbatim. Missing required ids
 * produce an authoring-error marker the runner surfaces as a failed seed
 * step (rather than crashing or silently skipping).
 */
// Top-level fixture keys are forwarded to the server verbatim inside
// `params.fixture`. Prototype-pollution rejection (`__proto__`, `constructor`,
// `prototype`) is enforced by the server-side `dispatchSeed` at a single
// canonical point (`src/lib/server/test-controller.ts`), NOT re-guarded here:
// surfacing the rejection through the normal seed-error path keeps one source
// of truth for the check, and the server-side handler is where a seed request
// can actually land from any client implementation. A future refactor that
// removes the server check must add the client guard before removing it.
export function buildSeedCalls(fixtures: StoryboardFixtures | undefined): SeedCall[] {
  if (!fixtures) return [];
  const calls: SeedCall[] = [];

  (fixtures.accounts ?? []).forEach((entry, i) => {
    const { account_id, ...fixtureFields } = entry;
    const label = account_id ?? `#${i}`;
    if (typeof account_id !== 'string' || account_id.length === 0) {
      calls.push({
        step_id: `seed_account.${label}`,
        title: `Seed account ${label}`,
        scenario: 'seed_account',
        params: { fixture: seedFixtureFromFields(fixtureFields) },
        authoring_error: `fixtures.accounts[${i}] requires a non-empty string 'account_id'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_account.${account_id}`,
      title: `Seed account ${account_id}`,
      scenario: 'seed_account',
      params: { account_id, fixture: seedFixtureFromFields(fixtureFields) },
    });
  });

  (fixtures.buyer_agents ?? []).forEach((entry, i) => {
    const { agent_url, ...params } = entry;
    const label = agent_url ?? `#${i}`;
    if (typeof agent_url !== 'string' || agent_url.length === 0) {
      calls.push({
        step_id: `seed_buyer_agent.${label}`,
        title: `Seed buyer agent ${label}`,
        scenario: 'seed_buyer_agent',
        params,
        authoring_error: `fixtures.buyer_agents[${i}] requires a non-empty string 'agent_url'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_buyer_agent.${agent_url}`,
      title: `Seed buyer agent ${agent_url}`,
      scenario: 'seed_buyer_agent',
      params: { agent_url, ...params },
    });
  });

  (fixtures.products ?? []).forEach((entry, i) => {
    const { product_id, ...fixture } = entry;
    const label = product_id ?? `#${i}`;
    if (typeof product_id !== 'string' || product_id.length === 0) {
      calls.push({
        step_id: `seed_product.${label}`,
        title: `Seed product ${label}`,
        scenario: 'seed_product',
        params: { fixture },
        authoring_error: `fixtures.products[${i}] requires a non-empty string 'product_id'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_product.${product_id}`,
      title: `Seed product ${product_id}`,
      scenario: 'seed_product',
      params: { product_id, fixture },
    });
  });

  (fixtures.pricing_options ?? []).forEach((entry, i) => {
    const { product_id, pricing_option_id, ...fixture } = entry;
    const label =
      pricing_option_id && product_id
        ? `${product_id}:${pricing_option_id}`
        : (pricing_option_id ?? product_id ?? `#${i}`);
    const missing: string[] = [];
    if (typeof product_id !== 'string' || product_id.length === 0) missing.push('product_id');
    if (typeof pricing_option_id !== 'string' || pricing_option_id.length === 0) missing.push('pricing_option_id');
    if (missing.length > 0) {
      calls.push({
        step_id: `seed_pricing_option.${label}`,
        title: `Seed pricing option ${label}`,
        scenario: 'seed_pricing_option',
        params: { ...(product_id && { product_id }), ...(pricing_option_id && { pricing_option_id }), fixture },
        authoring_error: `fixtures.pricing_options[${i}] requires non-empty string(s) for: ${missing.join(', ')}`,
      });
      return;
    }
    calls.push({
      step_id: `seed_pricing_option.${product_id}.${pricing_option_id}`,
      title: `Seed pricing option ${pricing_option_id} on ${product_id}`,
      scenario: 'seed_pricing_option',
      params: { product_id, pricing_option_id, fixture },
    });
  });

  (fixtures.creative_formats ?? []).forEach((entry, i) => {
    const { format_id, ...fixtureFields } = entry;
    const label = format_id ?? `#${i}`;
    if (typeof format_id !== 'string' || format_id.length === 0) {
      calls.push({
        step_id: `seed_creative_format.${label}`,
        title: `Seed creative format ${label}`,
        scenario: 'seed_creative_format',
        params: { fixture: seedFixtureFromFields(fixtureFields) },
        authoring_error: `fixtures.creative_formats[${i}] requires a non-empty string 'format_id'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_creative_format.${format_id}`,
      title: `Seed creative format ${format_id}`,
      scenario: 'seed_creative_format',
      params: { format_id, fixture: seedFixtureFromFields(fixtureFields) },
    });
  });

  (fixtures.creatives ?? []).forEach((entry, i) => {
    const { creative_id, ...fixture } = entry;
    const label = creative_id ?? `#${i}`;
    if (typeof creative_id !== 'string' || creative_id.length === 0) {
      calls.push({
        step_id: `seed_creative.${label}`,
        title: `Seed creative ${label}`,
        scenario: 'seed_creative',
        params: { fixture },
        authoring_error: `fixtures.creatives[${i}] requires a non-empty string 'creative_id'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_creative.${creative_id}`,
      title: `Seed creative ${creative_id}`,
      scenario: 'seed_creative',
      params: { creative_id, fixture },
    });
  });

  (fixtures.plans ?? []).forEach((entry, i) => {
    const { plan_id, ...fixture } = entry;
    const label = plan_id ?? `#${i}`;
    if (typeof plan_id !== 'string' || plan_id.length === 0) {
      calls.push({
        step_id: `seed_plan.${label}`,
        title: `Seed plan ${label}`,
        scenario: 'seed_plan',
        params: { fixture },
        authoring_error: `fixtures.plans[${i}] requires a non-empty string 'plan_id'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_plan.${plan_id}`,
      title: `Seed plan ${plan_id}`,
      scenario: 'seed_plan',
      params: { plan_id, fixture },
    });
  });

  (fixtures.media_buys ?? []).forEach((entry, i) => {
    const { media_buy_id, ...fixture } = entry;
    const label = media_buy_id ?? `#${i}`;
    if (typeof media_buy_id !== 'string' || media_buy_id.length === 0) {
      calls.push({
        step_id: `seed_media_buy.${label}`,
        title: `Seed media buy ${label}`,
        scenario: 'seed_media_buy',
        params: { fixture },
        authoring_error: `fixtures.media_buys[${i}] requires a non-empty string 'media_buy_id'`,
      });
      return;
    }
    calls.push({
      step_id: `seed_media_buy.${media_buy_id}`,
      title: `Seed media buy ${media_buy_id}`,
      scenario: 'seed_media_buy',
      params: { media_buy_id, fixture },
    });
  });

  return calls;
}

function seedFixtureFromFields(fields: Record<string, unknown>): unknown {
  if (Object.keys(fields).length === 1 && Object.hasOwn(fields, 'fixture')) {
    return fields.fixture;
  }
  return fields;
}

export interface ControllerSeedingResult {
  /** Synthetic pre-flight phase to prepend to `StoryboardResult.phases[]`. */
  phase: StoryboardPhaseResult;
  /** True when every seed call succeeded; false means downstream phases must cascade-skip. */
  allPassed: boolean;
  /** Step counts to fold into the storyboard-level totals. */
  passedCount: number;
  failedCount: number;
  /**
   * Agent didn't advertise `comply_test_controller` — the storyboard can't
   * be graded against this seller. The runner cascade-skips real phases
   * with canonical `missing_test_controller` instead of the seeding-failed
   * path. Implements the spec's `fixture_seed_unsupported` not_applicable
   * grade (storyboard-schema.yaml `skip_reasons`).
   */
  missingController?: boolean;
  /**
   * Agent advertised `comply_test_controller`, but not one of the generated
   * seed_* scenarios this storyboard requires. This is a coverage gap, not
   * a failed agent behavior.
   */
  seedUnsupported?: boolean;
  /** At least one declared strategy ladder exhausted without a binding. */
  fixtureUnsatisfied?: boolean;
  /** Run-scoped bindings pinned for all subsequent storyboard phases. */
  bindings?: FixtureBindingRegistry;
  /** Machine-readable AdCP 3.2 resolution evidence. */
  resolutionRecords?: FixtureResolutionRecord[];
  /**
   * Declaration-local captures from the SAME selected graph, published only
   * when every declared fixture resolved. The runner commits them through the
   * protected-context funnel; they are never merged by plain assignment.
   */
  preparedCaptures?: PreparedFixtureCaptures;
}

/** Reserved-namespace values and provenance produced by fixture preparation. */
export interface PreparedFixtureCaptures {
  values: Record<string, unknown>;
  provenance: Record<string, ContextProvenanceEntry>;
  /** Per-handle witness retained for the entity that was actually selected. */
  witnesses: Record<string, CollectionSelectionWitness>;
}

/**
 * Fire every seed call for this storyboard. Returns `null` when seeding is
 * not applicable (opt-out, no declaration, empty fixtures) so the runner can
 * treat a no-op identically to a non-seeding storyboard.
 */
export async function runControllerSeeding(
  client: TestClient,
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  context: StoryboardContext,
  discoveryClient: TestClient = client,
  resolveFixtureAgent?: (
    task: 'comply_test_controller' | 'get_products',
    call?: SeedCall
  ) => {
    client: TestClient;
    options: StoryboardRunOptions;
  }
): Promise<ControllerSeedingResult | null> {
  if (options.skip_controller_seeding === true) return null;
  const calls = buildSeedCalls(storyboard.fixtures);
  if (calls.length === 0) return null;
  if (storyboard.fixture_resolution !== undefined) {
    const resolutionCalls =
      storyboard.prerequisites?.controller_seeding === true
        ? calls
        : calls.filter(call => call.scenario === 'seed_product' || call.scenario === 'seed_pricing_option');
    if (resolutionCalls.length === 0) return null;
    return runDeclaredFixtureResolution(
      client,
      discoveryClient,
      storyboard,
      options,
      context,
      resolutionCalls,
      resolveFixtureAgent
    );
  }
  if (storyboard.prerequisites?.controller_seeding !== true) return null;

  if (resolveFixtureAgent) {
    return runRoutedControllerSeeding(storyboard, calls, context, resolveFixtureAgent);
  }

  // If we can see the agent's tool list and `comply_test_controller` is
  // absent, grade as not_applicable rather than issuing calls that are
  // guaranteed to fail on the wire. Spec: `fixture_seed_unsupported` in
  // storyboard-schema.yaml — missing test-controller is a coverage gap, not
  // a setup break. `options.agentTools` is discovered from the agent profile
  // or passed explicitly by the caller; we don't enforce when it's absent
  // because some harnesses skip tool discovery.
  //
  // In single-agent mode the discovered tool list belongs to the seed client.
  const controllerRouteTools = options.agentTools;
  if (controllerRouteTools && !controllerRouteTools.includes('comply_test_controller')) {
    return buildMissingControllerResult(storyboard, calls, context);
  }

  const start = Date.now();
  const steps: StoryboardStepResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let allPassed = true;
  const seedContext = { correlation_id: `${storyboardCorrelationPrefix(storyboard)}--__seeding__` };
  const authoringErrorResult = buildAuthoringErrorResult(storyboard, calls, context, start);
  if (authoringErrorResult) return authoringErrorResult;
  const unsupportedScenario = await findUnsupportedSeedScenario(client, calls, options, seedContext);
  if (unsupportedScenario) {
    return buildUnsupportedSeedResult(
      storyboard,
      calls,
      context,
      unsupportedScenario.scenario,
      unsupportedScenario.detail
    );
  }

  for (const call of calls) {
    const stepStart = Date.now();
    let passed = false;
    let error: string | undefined;

    if (call.authoring_error) {
      error = call.authoring_error;
    } else {
      try {
        const raw = await callControllerRaw(
          client,
          { scenario: call.scenario, params: call.params, context: seedContext },
          options
        );
        const data = raw.data as { success?: boolean; error?: string; error_detail?: string } | undefined;
        if (raw.success && data?.success === true) {
          passed = true;
        } else if (raw.success && data?.success === false && data.error === 'UNKNOWN_SCENARIO') {
          return buildUnsupportedSeedResult(storyboard, calls, context, call.scenario, data.error_detail);
        } else {
          error = formatControllerError(call.scenario, raw, data);
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const step: StoryboardStepResult = {
      storyboard_id: storyboard.id,
      step_id: call.step_id,
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      title: call.title,
      task: 'comply_test_controller',
      passed,
      duration_ms: Date.now() - stepStart,
      validations: [],
      context,
      extraction: { path: 'none' },
      ...(error !== undefined && { error }),
    };
    steps.push(step);
    if (passed) {
      passedCount++;
    } else {
      failedCount++;
      allPassed = false;
    }
  }

  return {
    phase: {
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      phase_title: 'Controller seeding (pre-flight)',
      passed: allPassed,
      steps,
      duration_ms: Date.now() - start,
    },
    allPassed,
    passedCount,
    failedCount,
  };
}

/** Seed each fixture against the route that owns its state. */
async function runRoutedControllerSeeding(
  storyboard: Storyboard,
  calls: SeedCall[],
  context: StoryboardContext,
  resolveFixtureAgent: (
    task: 'comply_test_controller' | 'get_products',
    call?: SeedCall
  ) => {
    client: TestClient;
    options: StoryboardRunOptions;
  }
): Promise<ControllerSeedingResult> {
  const start = Date.now();
  const authoringError = buildAuthoringErrorResult(storyboard, calls, context, start);
  if (authoringError) return authoringError;

  const seedContext = { correlation_id: `${storyboardCorrelationPrefix(storyboard)}--__seeding__` };
  const selected = calls.map(call => ({ call, route: resolveFixtureAgent('comply_test_controller', call) }));
  const missing = selected.find(({ route }) => route.options.agentTools?.includes('comply_test_controller') === false);
  if (missing) {
    return buildMissingControllerResult(storyboard, calls, context);
  }

  const scenarios = new Map<TestClient, Set<string> | null>();
  for (const { call, route } of selected) {
    if (!scenarios.has(route.client)) {
      scenarios.set(
        route.client,
        controllerScenarioSetFromOptions(route.options) ??
          (await fetchControllerScenarioSet(route.client, route.options, seedContext))
      );
    }
    if (scenarios.get(route.client)?.has(call.scenario) === false) {
      return buildUnsupportedSeedResult(
        storyboard,
        calls,
        context,
        call.scenario,
        `The selected route did not advertise ${call.scenario}.`
      );
    }
  }

  const steps: StoryboardStepResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  for (const [index, { call, route }] of selected.entries()) {
    const result = await executeLegacySeedCall(route.client, storyboard, call, route.options, context, seedContext);
    if (result.step.skip_reason === 'fixture_unsatisfied') {
      // A controller can withdraw support after preflight. Keep the results
      // of earlier writes visible rather than relabeling them as skipped.
      const unsupported = buildUnsupportedSeedResult(
        storyboard,
        selected.slice(index).map(item => item.call),
        context,
        call.scenario,
        result.step.skip?.detail
      );
      return {
        ...unsupported,
        phase: {
          ...unsupported.phase,
          passed: failedCount === 0,
          steps: [...steps, ...unsupported.phase.steps],
          duration_ms: Date.now() - start,
        },
        allPassed: failedCount === 0,
        passedCount,
        failedCount,
        seedUnsupported: failedCount === 0,
      };
    }
    steps.push(result.step);
    if (result.step.passed) passedCount++;
    else failedCount++;
  }
  return {
    phase: {
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      phase_title: 'Controller seeding (pre-flight)',
      passed: failedCount === 0,
      steps,
      duration_ms: Date.now() - start,
    },
    allPassed: failedCount === 0,
    passedCount,
    failedCount,
  };
}

/**
 * One actual `get_products` exchange from the discovery ladder.
 *
 * `runner-output-contract.yaml` makes `request` and `response` required on
 * a failing validation, with null reserved for pre-wire failures. A capture
 * that cannot be built from a pinned entity is NOT pre-wire — the entity
 * came off the wire — so the failing result has to carry the exchange that
 * produced it rather than an explicit "no contact" null.
 */
interface DiscoveryExchange {
  request: RunnerRequestRecord;
  response: RunnerResponseRecord;
}

interface DiscoveryCatalog {
  products: Array<Record<string, unknown>>;
  evidence: { page_count: number; product_count: number; cursors: string[] };
  /** Per-page exchanges, in request order. */
  exchanges: DiscoveryExchange[];
  /** product_id → index into `exchanges`, so a failure cites ITS page. */
  pageOfProduct: Map<string, number>;
}

/**
 * The exchange that actually carried `productId`.
 *
 * Falls back to the final page when the id is unknown — a paginated run
 * still records a real exchange, and `evidence.page_count` / `cursors`
 * disclose that more pages existed.
 */
function discoveryExchangeFor(catalog: DiscoveryCatalog, productId: string | undefined): DiscoveryExchange | undefined {
  const index = productId === undefined ? undefined : catalog.pageOfProduct.get(productId);
  return catalog.exchanges[index ?? catalog.exchanges.length - 1];
}

type DiscoveryCatalogResult =
  | { ok: true; catalog: DiscoveryCatalog }
  | {
      ok: false;
      error: string;
      evidence?: unknown;
      /**
       * The actual exchange that failed, so the producer step can record
       * truthful wire evidence instead of nothing. `response` is null only
       * when the transport threw and no response was ever received — never
       * a stand-in for one we did not capture.
       */
      exchange?: { request: RunnerRequestRecord; response: RunnerResponseRecord | null };
      /** AJV detail when the page parsed but failed its response schema. */
      schemaFailure?: string;
    };

/** AdCP 3.2 ordered per-handle seed/discover state machine. */
async function runDeclaredFixtureResolution(
  seedClient: TestClient,
  discoveryClient: TestClient,
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  context: StoryboardContext,
  calls: SeedCall[],
  resolveFixtureAgent?: (
    task: 'comply_test_controller' | 'get_products',
    call?: SeedCall
  ) => {
    client: TestClient;
    options: StoryboardRunOptions;
  }
): Promise<ControllerSeedingResult> {
  const start = Date.now();
  const authoringErrorResult = buildAuthoringErrorResult(storyboard, calls, context, start);
  if (authoringErrorResult) return authoringErrorResult;

  const specs = buildFixtureResolutionSpecs(storyboard);
  const specByKey = new Map<string, FixtureResolutionSpec>();
  for (const spec of specs) {
    specByKey.set(
      spec.entityType === 'product'
        ? `seed_product\0${spec.handle}`
        : `seed_pricing_option\0${spec.parentProductHandle}\0${spec.handle}`,
      spec
    );
  }
  const declaredCalls = new Map<string, SeedCall>();
  for (const call of calls) {
    const spec = resolutionSpecForCall(call, specByKey);
    if (spec) declaredCalls.set(resolutionSpecKey(spec), call);
  }
  const orderedDeclaredCalls = specs
    .map(spec => declaredCalls.get(resolutionSpecKey(spec)))
    .filter((call): call is SeedCall => call !== undefined);
  let declaredCallIndex = 0;
  const orderedCalls = calls.map(call =>
    resolutionSpecForCall(call, specByKey) ? orderedDeclaredCalls[declaredCallIndex++]! : call
  );

  const bindings = new FixtureBindingRegistry();
  const records: FixtureResolutionRecord[] = [];
  const steps: StoryboardStepResult[] = [];
  const claimedProducts = new Map<string, boolean>();
  const claimedPricingOptions = new Map<string, boolean>();
  const productStatuses = new Map<string, FixtureResolutionRecord['status']>();
  // Declaration-local captures stay pending until the WHOLE graph resolves.
  // Publishing early would expose a selected-product id from a graph whose
  // scoped price later failed, and a step would build a request against an
  // entity the run never actually pinned.
  const pendingCaptures: Array<{
    spec: FixtureResolutionSpec;
    key: string;
    value: unknown;
    sourceTask: 'get_products' | 'comply_test_controller';
  }> = [];
  const retainedWitnesses = new Map<string, CollectionSelectionWitness>();
  let captureFailure: string | undefined;
  /**
   * Per-handle capture-failure diagnostics.
   *
   * Keyed by handle, NOT run-global: the loop below does not stop at the
   * first failing declaration, so a single shared pointer/exchange gave
   * the second failing handle the FIRST handle's evidence while its
   * `error` was its own. `json_pointer` must point at the field that
   * failed on THIS declaration, and `request`/`response` must be the
   * exchange that produced THIS entity.
   *
   * `pointer` is the RFC 6901 form of the capture path, when it had one.
   * `exchange` is the real wire records: `fixture_capture_unbuildable` is
   * a post-wire failure, so required_on_failure request/response must be
   * the actual exchange, not the nulls reserved for a pre-wire refusal.
   */
  const captureFailures = new Map<string, { pointer?: string; exchange?: DiscoveryExchange }>();
  // Set alongside `captureFailure` so the synthesized validation does not
  // have to recognize the failure by its prose.
  const captureFailedHandles = new Set<string>();
  const seedContext = { correlation_id: `${storyboardCorrelationPrefix(storyboard)}--__seeding__` };
  let seedOptions = options;
  let discoveryOptions = options;
  let seedPrepared = false;
  let discoveryPrepared = false;
  const controller: { missing: boolean; scenarios: Set<string> | null } = { missing: false, scenarios: null };
  const prepareSeedAgent = async (call?: SeedCall) => {
    if (seedPrepared && !resolveFixtureAgent) return;
    const selected = resolveFixtureAgent?.('comply_test_controller', call);
    if (selected) {
      seedClient = selected.client;
      seedOptions = selected.options;
    }
    controller.missing = seedOptions.agentTools?.includes('comply_test_controller') === false;
    controller.scenarios = controller.missing ? new Set<string>() : controllerScenarioSetFromOptions(seedOptions);
    if (!controller.missing && !controller.scenarios) {
      controller.scenarios = await fetchControllerScenarioSet(seedClient, seedOptions, seedContext);
    }
    seedPrepared = true;
  };
  const prepareDiscoveryAgent = (call?: SeedCall) => {
    if (discoveryPrepared && !resolveFixtureAgent) return;
    const selected = resolveFixtureAgent?.('get_products', call);
    if (selected) {
      discoveryClient = selected.client;
      discoveryOptions = selected.options;
    }
    discoveryPrepared = true;
  };
  const legacyCalls = calls.filter(call => resolutionSpecForCall(call, specByKey) === undefined);
  if (legacyCalls.length > 0 && !resolveFixtureAgent) {
    await prepareSeedAgent();
    if (controller.missing) return buildMissingControllerResult(storyboard, legacyCalls, context);
    if (controller.scenarios) {
      const unsupported = legacyCalls.find(call => !call.authoring_error && !controller.scenarios!.has(call.scenario));
      if (unsupported) {
        return buildUnsupportedSeedResult(
          storyboard,
          legacyCalls,
          context,
          unsupported.scenario,
          `list_scenarios did not advertise required seed scenario "${unsupported.scenario}".`
        );
      }
    }
  }
  const needsSeedStrategy = orderedCalls.some(call => {
    const spec = resolutionSpecForCall(call, specByKey);
    return !spec || spec.strategies.includes('seed');
  });
  // Preserve standalone preparation order. Routed fallback operations are
  // resolved only if their strategy is reached, so unrelated routes cannot
  // prevent a valid earlier strategy from satisfying the fixture.
  if (!resolveFixtureAgent && needsSeedStrategy && !seedPrepared) await prepareSeedAgent();
  const catalogs = new Map<TestClient, Promise<DiscoveryCatalogResult>>();
  const catalog = () => {
    let promise = catalogs.get(discoveryClient);
    if (!promise) {
      promise = discoverProductCatalog(discoveryClient, discoveryOptions, context);
      catalogs.set(discoveryClient, promise);
    }
    return promise;
  };

  let passedCount = 0;
  let failedCount = 0;
  let fixtureUnsatisfied = false;

  for (const call of orderedCalls) {
    const spec = resolutionSpecForCall(call, specByKey);
    // The first production slice only changes product and product-pricing
    // handles. Every other entity keeps the legacy seed-only behavior.
    if (!spec) {
      if (resolveFixtureAgent) {
        await prepareSeedAgent(call);
        if (controller.missing) return buildMissingControllerResult(storyboard, legacyCalls, context);
        if (controller.scenarios && !controller.scenarios.has(call.scenario)) {
          return buildUnsupportedSeedResult(
            storyboard,
            legacyCalls,
            context,
            call.scenario,
            `The selected route did not advertise ${call.scenario}.`
          );
        }
      }
      const legacy = await executeLegacySeedCall(seedClient, storyboard, call, seedOptions, context, seedContext);
      if (legacy.step.skip_reason === 'fixture_unsatisfied') {
        return buildUnsupportedSeedResult(storyboard, legacyCalls, context, call.scenario, legacy.step.skip?.detail);
      }
      steps.push(legacy.step);
      if (legacy.step.passed) passedCount++;
      else failedCount++;
      continue;
    }

    const attempts: FixtureResolutionAttempt[] = [];
    let boundIds: FixtureResolutionRecord['seller_ids'];
    let chosenStrategy: FixtureResolutionRecord['strategy'];
    /**
     * The strategy whose wire call actually ran, successful or not.
     *
     * `chosenStrategy` is only assigned when a strategy RESOLVES, so a
     * discover-only handle that failed left it undefined and the step
     * label fell through to `comply_test_controller` — claiming a
     * controller seed for a run whose only traffic was `get_products`.
     */
    let attemptedStrategy: FixtureResolutionRecord['strategy'];
    /** Truthful wire evidence for a failed discovery, never fabricated. */
    let discoveryFailureEvidence: { request: RunnerRequestRecord; response: RunnerResponseRecord | null } | undefined;
    let discoverySchemaFailure: string | undefined;
    let failure: string | undefined;
    const stepStart = Date.now();
    const parentStatus = spec.parentProductHandle ? productStatuses.get(spec.parentProductHandle) : undefined;
    const parentUnavailable = spec.entityType === 'product_pricing_option' && parentStatus !== 'resolved';
    if (parentUnavailable) {
      const strategy = spec.strategies[0]!;
      const detail =
        parentStatus === 'failed'
          ? `parent product handle "${spec.parentProductHandle}" failed resolution`
          : `parent product handle "${spec.parentProductHandle}" is unavailable`;
      attempts.push({ strategy, disposition: parentStatus === 'failed' ? 'failed' : 'unavailable', detail });
      if (parentStatus === 'failed') failure = detail;
    }

    for (const strategy of parentUnavailable ? [] : spec.strategies) {
      if (strategy === 'seed') {
        attemptedStrategy = strategy;
        await prepareSeedAgent(call);
        const advertised = controller.scenarios?.has(call.scenario);
        if (controller.missing || advertised === false) {
          attempts.push({
            strategy,
            disposition: 'unavailable',
            detail: controller.missing
              ? 'comply_test_controller is not advertised'
              : `list_scenarios did not advertise ${call.scenario}`,
          });
          continue;
        }
        try {
          const controllerRequest = applyFixtureBindingsToRequest(
            { scenario: call.scenario, params: call.params },
            'comply_test_controller',
            bindings,
            options.adcpVersion ?? ADCP_VERSION
          );
          const raw = await callControllerRaw(
            seedClient,
            {
              scenario: call.scenario,
              params: isPlainRecord(controllerRequest.params) ? controllerRequest.params : call.params,
              context: seedContext,
            },
            seedOptions
          );
          const data = raw.data as { success?: boolean; error?: string; error_detail?: string } | undefined;
          if (raw.success && data?.success === true) {
            boundIds = bindSeededFixture(spec, bindings);
            // A seeded entity's authored fixture body IS the graph the seller
            // was instructed to create, so it is the honest capture source.
            // No seller catalog read is substituted for it.
            const seedSnapshot: Record<string, unknown> = {
              ...spec.fixture,
              ...(spec.entityType === 'product'
                ? { product_id: boundIds.product_id }
                : { pricing_option_id: boundIds.pricing_option_id }),
            };
            const seedWitness = matchFixtureRequirementsWithWitness(seedSnapshot, spec.clauses).witness;
            if (seedWitness) retainedWitnesses.set(spec.handle, seedWitness);
            const seedCaptures = collectDeclaredCaptures(spec, seedSnapshot, seedWitness);
            if (!seedCaptures.ok) {
              failure = seedCaptures.detail;
              captureFailure ??= seedCaptures.detail;
              captureFailures.set(spec.handle, {
                ...(seedCaptures.path !== undefined && { pointer: toJsonPointer(seedCaptures.path) }),
                exchange: {
                  request: {
                    transport: 'mcp',
                    operation: 'comply_test_controller',
                    // The object actually handed to `callControllerRaw`,
                    // not `controllerRequest` — the call substitutes
                    // `call.params` when the bound params are not a plain
                    // record, and adds the seeding correlation context.
                    payload: redactSecrets({
                      scenario: call.scenario,
                      params: isPlainRecord(controllerRequest.params) ? controllerRequest.params : call.params,
                      context: seedContext,
                    }),
                  },
                  response: { transport: 'mcp', payload: redactSecrets(raw.data ?? raw.error ?? null) },
                },
              });
              captureFailedHandles.add(spec.handle);
              attempts.push({ strategy, disposition: 'failed', detail: seedCaptures.detail });
              boundIds = undefined;
              break;
            }
            pendingCaptures.push(
              ...seedCaptures.captures.map(c => ({ ...c, sourceTask: 'comply_test_controller' as const }))
            );
            if (spec.entityType === 'product') {
              recordIdentityClaim(claimedProducts, boundIds.product_id!, spec.allowReuse);
            } else {
              recordIdentityClaim(
                claimedPricingOptions,
                `${boundIds.product_id}\0${boundIds.pricing_option_id}`,
                spec.allowReuse
              );
            }
            chosenStrategy = strategy;
            attempts.push({
              strategy,
              disposition: 'resolved',
              detail: `${call.scenario} accepted the authored literal id`,
            });
            break;
          }
          if (raw.success && data?.success === false && data.error === 'UNKNOWN_SCENARIO' && advertised !== true) {
            attempts.push({
              strategy,
              disposition: 'unavailable',
              detail: data.error_detail ?? `${call.scenario} returned UNKNOWN_SCENARIO`,
            });
            continue;
          }
          failure = formatControllerError(call.scenario, raw, data);
          attempts.push({ strategy, disposition: 'failed', detail: failure });
          break;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          attempts.push({ strategy, disposition: 'failed', detail: failure });
          break;
        }
      }

      if (strategy === 'discover') {
        attemptedStrategy = strategy;
        prepareDiscoveryAgent(call);
        if (discoveryOptions.agentTools && !discoveryOptions.agentTools.includes('get_products')) {
          attempts.push({
            strategy,
            disposition: 'unavailable',
            detail: 'agent did not advertise get_products',
          });
          continue;
        }
        const discovered = await catalog();
        if (!discovered.ok) {
          failure = discovered.error;
          discoveryFailureEvidence = discovered.exchange;
          discoverySchemaFailure = discovered.schemaFailure;
          attempts.push({ strategy, disposition: 'failed', detail: failure, response: discovered.evidence });
          break;
        }
        const selected = selectDiscoveredFixture(
          spec,
          discovered.catalog.products,
          bindings,
          claimedProducts,
          claimedPricingOptions,
          spec.entityType === 'product'
            ? specs.filter(
                candidate =>
                  candidate.entityType === 'product_pricing_option' && candidate.parentProductHandle === spec.handle
              )
            : []
        );
        if (!selected.ok) {
          if (selected.failed) {
            failure = selected.detail;
            attempts.push({
              strategy,
              disposition: 'failed',
              detail: selected.detail,
              response: discovered.catalog.evidence,
            });
            break;
          }
          attempts.push({
            strategy,
            disposition: 'unavailable',
            detail: selected.detail,
            response: discovered.catalog.evidence,
          });
          continue;
        }
        boundIds = selected.boundIds;
        chosenStrategy = strategy;
        if (selected.witness) retainedWitnesses.set(spec.handle, selected.witness);
        const collected = collectDeclaredCaptures(spec, selected.snapshot, selected.witness);
        if (!collected.ok) {
          failure = collected.detail;
          captureFailure ??= collected.detail;
          const failureExchange = discoveryExchangeFor(discovered.catalog, selected.boundIds.product_id);
          captureFailures.set(spec.handle, {
            ...(collected.path !== undefined && { pointer: toJsonPointer(collected.path) }),
            ...(failureExchange && { exchange: failureExchange }),
          });
          captureFailedHandles.add(spec.handle);
          attempts.push({
            strategy,
            disposition: 'failed',
            detail: collected.detail,
            response: { ...discovered.catalog.evidence, selected: selected.boundIds },
          });
          boundIds = undefined;
          break;
        }
        pendingCaptures.push(...collected.captures.map(c => ({ ...c, sourceTask: 'get_products' as const })));
        attempts.push({
          strategy,
          disposition: 'resolved',
          detail: selected.detail,
          response: { ...discovered.catalog.evidence, selected: selected.boundIds },
        });
        break;
      }
    }

    const status: FixtureResolutionRecord['status'] = boundIds ? 'resolved' : failure ? 'failed' : 'unsatisfied';
    if (spec.entityType === 'product') productStatuses.set(spec.handle, status);
    const record: FixtureResolutionRecord = {
      fixture_type: spec.entityType === 'product' ? 'product' : 'pricing_option',
      handle: spec.handle,
      ...(spec.parentProductHandle && { product_handle: spec.parentProductHandle }),
      requirements: spec.clauses,
      strategies_attempted: attempts,
      status,
      ...(chosenStrategy && { strategy: chosenStrategy }),
      ...(boundIds && { seller_ids: boundIds }),
    };
    records.push(record);

    if (status !== 'unsatisfied') {
      const captureFailed = status === 'failed' && captureFailedHandles.has(spec.handle);
      steps.push({
        storyboard_id: storyboard.id,
        step_id: call.step_id,
        phase_id: CONTROLLER_SEEDING_PHASE_ID,
        title: call.title,
        // The task that ACTUALLY ran, else the one this handle declared.
        // Falling back to the controller whenever no strategy RESOLVED
        // attributed a failed discover-only handle to a seed call that
        // never happened — and a handle abandoned because its parent
        // failed makes no call at all, so it is named by the strategy it
        // declared rather than by a different tool. Such a step carries
        // no request record, so nothing implies a call was made.
        task:
          (chosenStrategy ?? attemptedStrategy ?? spec.strategies[0]) === 'discover'
            ? 'get_products'
            : 'comply_test_controller',
        passed: status !== 'failed',
        duration_ms: Date.now() - stepStart,
        // An unbuildable capture gets a `check` discriminator like the other
        // two failure classes, so a report renderer keys on `check` for all
        // three instead of regexing prose for this one.
        validations: captureFailed
          ? [
              {
                check: 'fixture_capture_unbuildable',
                passed: false,
                description: 'Every declared fixture capture must be buildable from the pinned entity',
                error: failure,
                // The contract's analogue, `capture_path_not_resolvable`,
                // requires the RFC 6901 form of the `context_outputs` path
                // that failed. `null` only for the witness and size/depth
                // arms, which genuinely have no path.
                json_pointer: captureFailures.get(spec.handle)?.pointer ?? null,
                expected: 'a value at the declared selected-entity path, or a derivable witness',
                actual: null,
                // required_on_failure: null only when the check is not a
                // response_schema check, which this never is.
                schema_id: null,
                schema_url: null,
                ...(captureFailures.get(spec.handle)?.exchange ?? {}),
              },
            ]
          : discoverySchemaFailure !== undefined
            ? [
                // A page that parsed but failed its response schema is a
                // `response_schema` failure, not a capture failure. Using
                // the contract's own kind keeps the schema identity where
                // consumers already look for it.
                {
                  check: 'response_schema',
                  passed: false,
                  description: 'Fixture discovery response must satisfy the get_products response schema',
                  error: discoverySchemaFailure,
                  json_pointer: null,
                  ...resolveDiscoverySchemaIdentity(options.adcpVersion ?? ADCP_VERSION),
                  actual: 'schema_validation_failed',
                  ...(discoveryFailureEvidence && {
                    request: discoveryFailureEvidence.request,
                    response: discoveryFailureEvidence.response,
                  }),
                },
              ]
            : [],
        context,
        extraction: { path: 'none' },
        // The REAL exchange the failing strategy made. Absent rather than
        // invented when the strategy never reached the wire.
        ...(discoveryFailureEvidence && {
          request: discoveryFailureEvidence.request,
          ...(discoveryFailureEvidence.response && { response_record: discoveryFailureEvidence.response }),
        }),
        ...(failure && { error: failure }),
      });
    }
    if (status === 'failed') failedCount++;
    else if (status === 'unsatisfied') fixtureUnsatisfied = true;
    else passedCount++;
  }

  const allPassed = failedCount === 0;
  // All-or-nothing: a capture is published only when every declared fixture
  // in the graph resolved. A partial graph publishes nothing, so a step can
  // never read a pinned identity whose sibling price never bound.
  const graphComplete =
    allPassed && !fixtureUnsatisfied && captureFailure === undefined && records.every(r => r.status === 'resolved');
  const preparedCaptures: PreparedFixtureCaptures | undefined =
    graphComplete && pendingCaptures.length > 0
      ? {
          values: Object.fromEntries(pendingCaptures.map(entry => [entry.key, entry.value])),
          provenance: Object.fromEntries(
            pendingCaptures.map(entry => [
              entry.key,
              {
                source_step_id: CONTROLLER_SEEDING_PHASE_ID,
                source_kind: 'fixture_preparation' as const,
                source_task: entry.sourceTask,
                fixture_handle: entry.spec.handle,
                ...(entry.spec.parentProductHandle && { fixture_product_handle: entry.spec.parentProductHandle }),
              },
            ])
          ),
          witnesses: Object.fromEntries(retainedWitnesses),
        }
      : undefined;
  return {
    phase: {
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      phase_title: 'Fixture resolution (pre-flight)',
      passed: allPassed,
      steps,
      duration_ms: Date.now() - start,
    },
    allPassed,
    passedCount,
    failedCount,
    fixtureUnsatisfied,
    bindings,
    resolutionRecords: records,
    ...(preparedCaptures && { preparedCaptures }),
  };
}

/**
 * Dotted storyboard capture path → RFC 6901 JSON pointer.
 *
 * `pricing_options[0].rate` → `/pricing_options/0/rate`. `~` and `/` are
 * escaped per RFC 6901 before the segments are joined.
 */
function toJsonPointer(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(segment => segment.length > 0)
    .map(segment => segment.replace(/~/g, '~0').replace(/\//g, '~1'));
  return segments.length > 0 ? `/${segments.join('/')}` : undefined;
}

type CollectedCaptures =
  | { ok: true; captures: Array<{ spec: FixtureResolutionSpec; key: string; value: unknown }> }
  | {
      ok: false;
      detail: string;
      /**
       * The declared capture path that failed to resolve, when the failure
       * HAS one.
       *
       * `runner-output-contract.yaml` requires the contract's analogue,
       * `capture_path_not_resolvable`, to carry the RFC 6901 form of the
       * path in `json_pointer`. The path was in hand at the failure site
       * and was being interpolated into prose and then discarded, so the
       * structured pointer could not be emitted. Absent for the witness
       * and size/depth arms, which genuinely have no path.
       */
      path?: string;
    };

/**
 * Pages whose `get_products` RESPONSE is retained as capture-failure
 * evidence. Requests are retained for every page regardless.
 */
const DISCOVERY_RETAINED_RESPONSE_PAGES = 16;

/** Maximum nesting depth a declared capture may carry. */
const CAPTURE_MAX_DEPTH = 64;
/** Maximum serialized size, in bytes, of a single declared capture. */
const CAPTURE_MAX_BYTES = 512 * 1024;

/**
 * Reject a capture the funnel could not detach safely.
 *
 * `snapshot: selected_entity` commits a seller-controlled catalog object,
 * and `structuredClone` throws a `RangeError` somewhere around 1,800 levels
 * of nesting while `JSON.parse` accepts hundreds of thousands. Inheriting
 * V8's stack limit as the de-facto bound would let the graded agent turn a
 * failing verdict into a crash — which reads as infrastructure flake and
 * gets retried, rather than being recorded. Bound it explicitly and grade
 * the overrun as the setup failure it is.
 */
function describeUncapturableValue(value: unknown, key: string): string | undefined {
  let depth = 0;
  const walk = (node: unknown, level: number): boolean => {
    if (level > depth) depth = level;
    if (depth > CAPTURE_MAX_DEPTH) return false;
    if (node === null || typeof node !== 'object') return true;
    if (Array.isArray(node)) return node.every(item => walk(item, level + 1));
    return Object.values(node as Record<string, unknown>).every(item => walk(item, level + 1));
  };
  if (!walk(value, 1)) {
    return `fixture capture "${key}" nests deeper than the ${CAPTURE_MAX_DEPTH}-level capture limit`;
  }
  let size: number;
  try {
    // Byte length, not `String.length`: the latter counts UTF-16 code units,
    // so 200,000 three-byte CJK characters would pass a 512 KiB check while
    // serializing to ~600 KiB.
    size = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return `fixture capture "${key}" is not JSON-serializable and cannot be detached`;
  }
  if (size > CAPTURE_MAX_BYTES) {
    return `fixture capture "${key}" serializes to ${size} bytes, over the ${CAPTURE_MAX_BYTES}-byte capture limit`;
  }
  return undefined;
}

function collectDeclaredCaptures(
  spec: FixtureResolutionSpec,
  snapshot: Record<string, unknown>,
  witness: CollectionSelectionWitness | undefined
): CollectedCaptures {
  if (spec.contextOutputs.length === 0) return { ok: true, captures: [] };
  const captures: Array<{ spec: FixtureResolutionSpec; key: string; value: unknown }> = [];
  for (const output of spec.contextOutputs) {
    if (output.snapshot !== undefined) {
      // The whole selected entity. Optional fields stay absent rather than
      // failing the capture or being defaulted; the funnel deep-clones and
      // deep-freezes it on commit.
      //
      // Redacted first. This is the only capture form that commits a WHOLE
      // seller-controlled object, and a committed capture is echoed in
      // every subsequent step's `context` and can be rendered into a
      // `context_value_rejected` hint. The repo already refuses to extract
      // `auth_token` into storyboard context for exactly this reason
      // (`context.ts`), so a snapshot must not reintroduce the surface for
      // a token-shaped field the catalog happens to carry. Only
      // secret-shaped KEYS are replaced; `product_id`, pricing and
      // collections are untouched, so nothing a declaration reads changes.
      captures.push({ spec, key: output.key, value: redactSecrets(snapshot) });
      continue;
    }
    if (output.witness !== undefined) {
      const read = readCollectionWitness(witness, output.witness);
      if (!read.ok) {
        return {
          ok: false,
          detail: `fixture capture "${output.key}" for handle "${spec.handle}" could not be built: ${read.detail}`,
        };
      }
      captures.push({ spec, key: output.key, value: read.value });
      continue;
    }
    // Resolved from the REDACTED snapshot, not redacted after resolving:
    // `redactSecrets` matches by field NAME, and a path that lands on a
    // scalar hands it a bare string with the name already gone, so
    // capturing `auth_token` would have come through verbatim.
    const value = resolvePath(redactSecrets(snapshot) as Record<string, unknown>, output.path!);
    // Null and "" are as unusable downstream as an absent path: substituting
    // either fabricates state the selected entity does not carry.
    if (value === undefined || value === null || value === '') {
      const pinned =
        spec.entityType === 'product'
          ? `product "${String(snapshot.product_id ?? spec.handle)}"`
          : `pricing option "${String(snapshot.pricing_option_id ?? spec.handle)}" on product "${spec.parentProductHandle}"`;
      return {
        ok: false,
        path: output.path!,
        detail:
          `fixture capture "${output.key}" (handle "${spec.handle}", pinned ${pinned}) found no usable value at ` +
          `selected-entity path "${output.path}" — resolved to ${value === undefined ? 'absent' : JSON.stringify(value)}. ` +
          `Either the path does not exist on this entity shape (top-level keys: ${Object.keys(snapshot).join(', ')}), ` +
          `or this seller does not populate it. If the field is OPTIONAL in the schema (fixed_price and ` +
          `min_spend_per_package both are), capture the whole entity with ` +
          `{ key: "${output.key}", snapshot: selected_entity } so absence stays absence. Add a match predicate ` +
          `for "${output.path}" only when carrying that field is a real eligibility requirement — gating on it ` +
          `stops a conformant seller qualifying at all.`,
      };
    }
    captures.push({ spec, key: output.key, value });
  }
  for (const capture of captures) {
    const unusable = describeUncapturableValue(capture.value, capture.key);
    if (unusable) return { ok: false, detail: unusable };
  }
  return { ok: true, captures };
}

function resolutionSpecKey(spec: FixtureResolutionSpec): string {
  return spec.entityType === 'product'
    ? `seed_product\0${spec.handle}`
    : `seed_pricing_option\0${spec.parentProductHandle}\0${spec.handle}`;
}

function resolutionSpecForCall(
  call: SeedCall,
  specs: ReadonlyMap<string, FixtureResolutionSpec>
): FixtureResolutionSpec | undefined {
  if (call.scenario === 'seed_product') {
    return specs.get(`seed_product\0${String(call.params.product_id ?? '')}`);
  }
  if (call.scenario === 'seed_pricing_option') {
    return specs.get(
      `seed_pricing_option\0${String(call.params.product_id ?? '')}\0${String(call.params.pricing_option_id ?? '')}`
    );
  }
  return undefined;
}

function bindSeededFixture(
  spec: FixtureResolutionSpec,
  bindings: FixtureBindingRegistry
): NonNullable<FixtureResolutionRecord['seller_ids']> {
  if (spec.entityType === 'product') {
    bindings.bindProduct(spec.handle, spec.handle);
    return { product_id: spec.handle };
  }
  const parent = spec.parentProductHandle!;
  bindings.bindPricingOption(parent, spec.handle, spec.handle);
  return { product_id: bindings.productId(parent) ?? parent, pricing_option_id: spec.handle };
}

async function executeLegacySeedCall(
  client: TestClient,
  storyboard: Storyboard,
  call: SeedCall,
  options: StoryboardRunOptions,
  context: StoryboardContext,
  seedContext: Record<string, unknown>
): Promise<{ step: StoryboardStepResult }> {
  const started = Date.now();
  try {
    const raw = await callControllerRaw(
      client,
      { scenario: call.scenario, params: call.params, context: seedContext },
      options
    );
    const data = raw.data as { success?: boolean; error?: string; error_detail?: string } | undefined;
    if (raw.success && data?.success === true) {
      return {
        step: {
          storyboard_id: storyboard.id,
          step_id: call.step_id,
          phase_id: CONTROLLER_SEEDING_PHASE_ID,
          title: call.title,
          task: 'comply_test_controller',
          passed: true,
          duration_ms: Date.now() - started,
          validations: [],
          context,
          extraction: { path: 'none' },
        },
      };
    }
    const unknown = raw.success && data?.success === false && data.error === 'UNKNOWN_SCENARIO';
    const detail = unknown
      ? `fixture_unsatisfied: ${call.scenario} is unavailable and no alternate strategy is declared`
      : formatControllerError(call.scenario, raw, data);
    return {
      step: {
        storyboard_id: storyboard.id,
        step_id: call.step_id,
        phase_id: CONTROLLER_SEEDING_PHASE_ID,
        title: call.title,
        task: 'comply_test_controller',
        passed: unknown,
        ...(unknown && {
          skipped: true,
          skip_reason: 'fixture_unsatisfied' as const,
          skip: { reason: 'not_applicable' as const, detail },
        }),
        duration_ms: Date.now() - started,
        validations: [],
        context,
        extraction: { path: 'none' },
        ...(!unknown && { error: detail }),
      },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      step: {
        storyboard_id: storyboard.id,
        step_id: call.step_id,
        phase_id: CONTROLLER_SEEDING_PHASE_ID,
        title: call.title,
        task: 'comply_test_controller',
        passed: false,
        duration_ms: Date.now() - started,
        validations: [],
        context,
        extraction: { path: 'none' },
        error: detail,
      },
    };
  }
}

/**
 * `{ schema_id, schema_url }` for the `get_products` response schema.
 *
 * Mirrors `resolveSchemaIdentity` in `validations.ts`: the id follows the
 * `/schemas/<version>/<path>.json` convention cached schemas use for
 * `$id`, and the url dereferences against the public docs origin so an
 * implementor can fetch exactly what the page was graded against.
 */
function resolveDiscoverySchemaIdentity(adcpVersion: string): { schema_id: string; schema_url: string } {
  const schemaId = `/schemas/${adcpVersion}/media-buy/get-products-response.json`;
  return { schema_id: schemaId, schema_url: `https://adcontextprotocol.org${schemaId}` };
}

/**
 * AJV detail for a discovery page that does not satisfy the `get_products`
 * response schema, or `undefined` when it does.
 */
function describeDiscoverySchemaFailure(data: unknown, options: StoryboardRunOptions): string | undefined {
  try {
    const validator = getValidator('get_products', 'sync', options.adcpVersion ?? ADCP_VERSION);
    if (validator) {
      const schemaData = isPlainRecord(data) ? injectLegacyEnvelopeStatus(data, { toolName: 'get_products' }) : data;
      if (validator(schemaData)) return undefined;
      return (validator.errors ?? [])
        .map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
        .join('; ');
    }
    const schema = validateResponseSchema('get_products', data, options.adcpVersion);
    return schema.passed ? undefined : (schema.error ?? schema.details ?? 'schema validation failed');
  } catch (err) {
    return `response schema unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function discoverProductCatalog(
  client: TestClient,
  options: StoryboardRunOptions,
  context: StoryboardContext
): Promise<DiscoveryCatalogResult> {
  const contextAccount = isPlainRecord(context.account) ? context.account : undefined;
  const baseAccount = contextAccount ?? resolveAccount(options);
  const account: Record<string, unknown> = { ...baseAccount };
  if (!('account_id' in account)) {
    account.sandbox = options.disable_sandbox === true || options.sandbox === false ? false : true;
  }
  const accountBrand = isPlainRecord(account.brand) ? account.brand : undefined;
  const brand = isPlainRecord(context.brand) ? context.brand : (accountBrand ?? resolveBrand(options));
  const products: Array<Record<string, unknown>> = [];
  const seenProductIds = new Set<string>();
  const cursors: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  const exchanges: DiscoveryExchange[] = [];
  const pageOfProduct = new Map<string, number>();
  do {
    if (pageCount >= 1_000) {
      return { ok: false, error: 'fixture discovery pagination exceeded the 1,000-page safety limit' };
    }
    const request: Record<string, unknown> = {
      buying_mode: 'wholesale',
      brand,
      account,
      pagination: { max_results: 100, ...(cursor && { cursor }) },
      // Fixture match declarations target the canonical product shape.
      ext: { adcp: { creative_wire: 'canonical' } },
    };
    let result;
    const pageStart = Date.now();
    // Recorded BEFORE dispatch. A transport failure never reaches the
    // response, but the request it sent is real and is the only evidence
    // an implementor has to reproduce the failure.
    const requestRecord: RunnerRequestRecord = {
      transport: 'mcp',
      operation: 'get_products',
      payload: redactSecrets(request),
    };
    try {
      result = await executeStoryboardTask(client, 'get_products', request, { signal: options.signal });
    } catch (err) {
      return {
        ok: false,
        error: `fixture discovery transport failure: ${err instanceof Error ? err.message : String(err)}`,
        evidence: { page_count: pageCount + 1, request },
        // Explicitly null: no response was received. Not a placeholder.
        exchange: { request: requestRecord, response: null },
      };
    }
    pageCount++;
    // Recorded for EVERY page, success or not: a schema-invalid or rejected
    // page is exactly the exchange a reader needs to see.
    // The request is tiny and always retained. The RESPONSE is a second
    // full copy of a page of products on top of the `products` array this
    // loop already accumulates, so retaining every page of a deep catalog
    // doubled peak memory for evidence that is read only when a capture
    // fails. Past the budget the page records that it was not retained,
    // rather than silently reading as an empty response.
    const retainResponse = exchanges.length < DISCOVERY_RETAINED_RESPONSE_PAGES;
    const pageIndex =
      exchanges.push({
        request: requestRecord,
        response: {
          transport: 'mcp',
          payload: retainResponse
            ? redactSecrets(
                result.data ??
                  (result.adcp_error ? { adcp_error: result.adcp_error } : undefined) ??
                  result.error ??
                  null
              )
            : {
                response_not_retained: `page ${exchanges.length + 1} is past the runner's ${DISCOVERY_RETAINED_RESPONSE_PAGES}-page discovery-evidence budget; the request for this page is recorded in full`,
              },
          duration_ms: Date.now() - pageStart,
        },
      }) - 1;
    // Graded whether or not the executor accepted the page. A seller that
    // returns a malformed body makes the executor reject in strict mode,
    // and classifying that as a bare protocol error hid WHICH of the two
    // it was — the one thing a `response_schema` record exists to say.
    const schemaFailure = result.data === undefined ? undefined : describeDiscoverySchemaFailure(result.data, options);
    if (!result.success) {
      return {
        ok: false,
        error: `fixture discovery get_products rejected: ${result.error ?? result.adcp_error?.code ?? 'unknown error'}`,
        evidence: { page_count: pageCount, request },
        exchange: exchanges[pageIndex]!,
        ...(schemaFailure !== undefined && { schemaFailure }),
      };
    }
    if (schemaFailure) {
      return {
        ok: false,
        error: `fixture discovery returned malformed get_products response: ${schemaFailure}`,
        evidence: { page_count: pageCount },
        exchange: exchanges[pageIndex]!,
        schemaFailure,
      };
    }
    if (!isPlainRecord(result.data)) {
      return {
        ...{ ok: false, error: 'fixture discovery returned a non-object get_products response' },
        exchange: exchanges[pageIndex]!,
      };
    }
    const pageProducts = result.data.products;
    if (pageProducts !== undefined && !Array.isArray(pageProducts)) {
      return {
        ...{ ok: false, error: 'fixture discovery get_products.products is not an array' },
        exchange: exchanges[pageIndex]!,
      };
    }
    for (const product of pageProducts ?? []) {
      if (!isPlainRecord(product) || typeof product.product_id !== 'string' || product.product_id.length === 0) {
        return {
          ...{ ok: false, error: 'fixture discovery returned a product without a non-empty product_id' },
          exchange: exchanges[pageIndex]!,
        };
      }
      if (seenProductIds.has(product.product_id)) {
        return {
          ok: false,
          error: `fixture discovery returned duplicate product_id "${product.product_id}"; response order cannot resolve duplicate identities`,
          exchange: exchanges[pageIndex]!,
        };
      }
      seenProductIds.add(product.product_id);
      if (Array.isArray(product.pricing_options)) {
        const seenPricingIds = new Set<string>();
        for (const option of product.pricing_options) {
          if (!isPlainRecord(option) || typeof option.pricing_option_id !== 'string') continue;
          if (seenPricingIds.has(option.pricing_option_id)) {
            return {
              ok: false,
              error: `fixture discovery returned duplicate pricing option identity "${product.product_id}\u0000${option.pricing_option_id}"`,
              exchange: exchanges[pageIndex]!,
            };
          }
          seenPricingIds.add(option.pricing_option_id);
        }
      }
      pageOfProduct.set(product.product_id, pageIndex);
      products.push(product);
      if (products.length > 100_000) {
        return {
          ...{ ok: false, error: 'fixture discovery exceeded the 100,000-product safety limit' },
          exchange: exchanges[pageIndex]!,
        };
      }
    }
    const pagination = isPlainRecord(result.data.pagination) ? result.data.pagination : undefined;
    if (pagination?.has_more === true) {
      const next = pagination.cursor;
      if (typeof next !== 'string' || next.length === 0) {
        return {
          ...{ ok: false, error: 'fixture discovery pagination is broken: has_more=true without cursor' },
          exchange: exchanges[pageIndex]!,
        };
      }
      if (seenCursors.has(next)) {
        return {
          ...{ ok: false, error: `fixture discovery pagination is broken: repeated cursor "${next}"` },
          exchange: exchanges[pageIndex]!,
        };
      }
      seenCursors.add(next);
      cursors.push(next);
      cursor = next;
    } else {
      cursor = undefined;
    }
  } while (cursor);
  return {
    ok: true,
    catalog: {
      products,
      evidence: { page_count: pageCount, product_count: products.length, cursors },
      exchanges,
      pageOfProduct,
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

type SelectedFixture =
  | {
      ok: true;
      boundIds: NonNullable<FixtureResolutionRecord['seller_ids']>;
      detail: string;
      /** The exact entity the resolver pinned, for declaration-local captures. */
      snapshot: Record<string, unknown>;
      /** Witness retained from the candidate that was selected, if any. */
      witness?: CollectionSelectionWitness;
    }
  | { ok: false; failed: boolean; detail: string };

function selectDiscoveredFixture(
  spec: FixtureResolutionSpec,
  products: Array<Record<string, unknown>>,
  bindings: FixtureBindingRegistry,
  claimedProducts: Map<string, boolean>,
  claimedPricingOptions: Map<string, boolean>,
  dependentPricingSpecs: readonly FixtureResolutionSpec[] = []
): SelectedFixture {
  if (spec.entityType === 'product') {
    // Qualification is applied to every complete validated candidate BEFORE
    // deterministic ordering, so a nonqualifying earlier product can never
    // conceal a later qualifying one. Each candidate is also required to
    // carry a pricing option its declared children can bind: otherwise the
    // bytewise-first product can win the parent selection and then strand
    // the whole graph on a child that another product would have satisfied.
    // Rejection reasons are counted, not discarded. Against a real seller's
    // catalog, "nothing satisfied the requirements" with no handle, no
    // candidate count and no reason is the least useful sentence the runner
    // can emit — and three different filters used to collapse into it.
    const rejections = new Map<string, number>();
    let claimedElsewhere = 0;
    let strandedChild = 0;
    const matched: Array<{ product: Record<string, unknown>; witness?: CollectionSelectionWitness }> = [];
    for (const product of products) {
      const match = matchFixtureRequirementsWithWitness(product, spec.clauses);
      if (!match.matched) {
        const reason = match.reason ?? 'did not satisfy the authored match predicates';
        rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
        continue;
      }
      if (!identityCanBeClaimed(claimedProducts, product.product_id as string, spec.allowReuse)) {
        claimedElsewhere++;
        continue;
      }
      if (!dependentPricingSpecs.every(child => productCanSatisfyPricingSpec(product, child))) {
        strandedChild++;
        continue;
      }
      matched.push({ product, ...(match.witness && { witness: match.witness }) });
    }
    matched.sort((a, b) => utf8Compare(a.product.product_id as string, b.product.product_id as string));
    const selected = matched[0]?.product;
    if (!selected) {
      return {
        ok: false,
        failed: false,
        detail: describeProductNoMatch(spec, products.length, rejections, claimedElsewhere, strandedChild),
      };
    }
    const productId = selected.product_id as string;
    bindings.bindProduct(spec.handle, productId);
    recordIdentityClaim(claimedProducts, productId, spec.allowReuse);
    return {
      ok: true,
      boundIds: { product_id: productId },
      detail: `selected product_id "${productId}" by UTF-8 bytewise order`,
      snapshot: selected,
      ...(matched[0]!.witness && { witness: matched[0]!.witness }),
    };
  }

  const parentHandle = spec.parentProductHandle!;
  const sellerProductId = bindings.productId(parentHandle);
  if (!sellerProductId) {
    return {
      ok: false,
      failed: true,
      detail: `pricing-option discovery requires bound parent product handle "${parentHandle}"`,
    };
  }
  const product = products.find(candidate => candidate.product_id === sellerProductId);
  if (!product) {
    return {
      ok: false,
      failed: true,
      detail: `bound parent product_id "${sellerProductId}" was absent from the completed discovery catalog`,
    };
  }
  const options = Array.isArray(product.pricing_options) ? product.pricing_options : [];
  const candidates = options
    .filter(isPlainRecord)
    .filter(option => typeof option.pricing_option_id === 'string' && option.pricing_option_id.length > 0)
    .filter(option => matchesFixtureRequirements(option, spec.clauses))
    .filter(option => {
      const identity = `${sellerProductId}\0${option.pricing_option_id as string}`;
      return identityCanBeClaimed(claimedPricingOptions, identity, spec.allowReuse);
    })
    .sort((a, b) =>
      utf8Compare(
        `${sellerProductId}\0${a.pricing_option_id as string}`,
        `${sellerProductId}\0${b.pricing_option_id as string}`
      )
    );
  const selected = candidates[0];
  if (!selected) {
    return {
      ok: false,
      failed: false,
      detail:
        `no pricing option on bound product "${sellerProductId}" satisfied fixture handle ` +
        `"${parentHandle}/${spec.handle}" — ${options.length} option(s) on the pinned product` +
        (options.length > 0
          ? `, pricing_option_id(s): ${options
              .filter(isPlainRecord)
              .map(option => String(option.pricing_option_id))
              .slice(0, 10)
              .join(', ')}`
          : ''),
    };
  }
  const pricingOptionId = selected.pricing_option_id as string;
  bindings.bindPricingOption(parentHandle, spec.handle, pricingOptionId);
  recordIdentityClaim(claimedPricingOptions, `${sellerProductId}\0${pricingOptionId}`, spec.allowReuse);
  return {
    ok: true,
    boundIds: { product_id: sellerProductId, pricing_option_id: pricingOptionId },
    detail: `selected pricing option "${sellerProductId}\u0000${pricingOptionId}" by UTF-8 bytewise order`,
    // The scoped price comes out of the same pinned product graph, so a
    // captured currency / fixed_price / min_spend_per_package describes the
    // option the buy will actually reference.
    snapshot: selected,
  };
}

/**
 * True when the candidate product carries at least one pricing option the
 * declared child could bind.
 *
 * Only applied to a discover-ONLY child. A child whose ladder still contains
 * `seed` can have its option created on whichever parent is chosen, so
 * requiring a pre-existing catalog match there would reject parents that the
 * controller would have seeded onto perfectly well.
 *
 * Existence only, and deliberately claim-blind: if two children each need a
 * distinct option and the chosen parent carries only one, the second child
 * still strands with "no pricing option on the bound product satisfied the
 * authored requirements". Threading the claim map through would make parent
 * selection depend on child resolution order, which is a larger change than
 * this foundation justifies — the stranding case is visible and diagnosable,
 * not silent.
 *
 * (Declared on `productCanSatisfyPricingSpec`, below.)
 */

/** Name the handle, the candidate count, and why each group was rejected. */
function describeProductNoMatch(
  spec: FixtureResolutionSpec,
  candidateCount: number,
  rejections: ReadonlyMap<string, number>,
  claimedElsewhere: number,
  strandedChild: number
): string {
  const parts = [
    `no discovered product satisfied fixture handle "${spec.handle}" — ${candidateCount} candidate(s) enumerated from the complete paginated catalog`,
  ];
  const top = [...rejections]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${count}x ${reason}`);
  // ` | `, not `; ` — an individual reason can itself contain a semicolon.
  if (top.length > 0) parts.push(`rejected by the authored match: ${top.join(' | ')}`);
  if (claimedElsewhere > 0) {
    parts.push(
      `${claimedElsewhere} otherwise-matching product(s) were already pinned to another handle — set allow_reuse: true on this declaration to share one seller entity`
    );
  }
  if (strandedChild > 0) {
    parts.push(
      `${strandedChild} matched but carried no pricing option the declared child pricing_options could bind — loosen the child match, or give the child a seed strategy`
    );
  }
  return parts.join('. ');
}

function productCanSatisfyPricingSpec(product: Record<string, unknown>, child: FixtureResolutionSpec): boolean {
  if (child.strategies.length !== 1 || child.strategies[0] !== 'discover') return true;
  const options = Array.isArray(product.pricing_options) ? product.pricing_options : [];
  return options
    .filter(isPlainRecord)
    .some(
      option =>
        typeof option.pricing_option_id === 'string' &&
        option.pricing_option_id.length > 0 &&
        matchesFixtureRequirements(option, child.clauses)
    );
}

/** A seller identity may be shared only when every claimant opts into reuse. */
function identityCanBeClaimed(claims: ReadonlyMap<string, boolean>, identity: string, allowReuse: boolean): boolean {
  const existingAllowsReuse = claims.get(identity);
  return existingAllowsReuse === undefined || (existingAllowsReuse && allowReuse);
}

function recordIdentityClaim(claims: Map<string, boolean>, identity: string, allowReuse: boolean): void {
  claims.set(identity, (claims.get(identity) ?? true) && allowReuse);
}

function storyboardCorrelationPrefix(storyboard: Storyboard): string {
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      const requestContext = step.sample_request?.context;
      if (!requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext)) continue;
      const correlationId = (requestContext as { correlation_id?: unknown }).correlation_id;
      if (typeof correlationId !== 'string' || correlationId.length === 0) continue;
      const suffixSeparator = correlationId.lastIndexOf('--');
      return suffixSeparator > 0 ? correlationId.slice(0, suffixSeparator) : correlationId;
    }
  }
  return storyboard.id;
}

function buildAuthoringErrorResult(
  storyboard: Storyboard,
  calls: SeedCall[],
  context: StoryboardContext,
  start: number
): ControllerSeedingResult | null {
  const authoringErrors = calls.filter((call): call is SeedCall & { authoring_error: string } =>
    Boolean(call.authoring_error)
  );
  if (authoringErrors.length === 0) return null;
  const steps: StoryboardStepResult[] = authoringErrors.map(call => ({
    storyboard_id: storyboard.id,
    step_id: call.step_id,
    phase_id: CONTROLLER_SEEDING_PHASE_ID,
    title: call.title,
    task: 'comply_test_controller',
    passed: false,
    duration_ms: 0,
    validations: [],
    context,
    extraction: { path: 'none' },
    error: call.authoring_error,
  }));
  return {
    phase: {
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      phase_title: 'Controller seeding (pre-flight) — invalid storyboard fixtures',
      passed: false,
      steps,
      duration_ms: Date.now() - start,
    },
    allPassed: false,
    passedCount: 0,
    failedCount: steps.length,
  };
}

async function findUnsupportedSeedScenario(
  client: TestClient,
  calls: SeedCall[],
  options: StoryboardRunOptions,
  seedContext: Record<string, unknown>
): Promise<{ scenario: SeedScenario | BuyerAgentSeedScenario; detail: string } | null> {
  const requiredScenarios = [...new Set(calls.filter(call => !call.authoring_error).map(call => call.scenario))];
  if (requiredScenarios.length === 0) return null;

  let advertisedScenarios = controllerScenarioSetFromOptions(options);
  if (!advertisedScenarios) {
    advertisedScenarios = await fetchControllerScenarioSet(client, options, seedContext);
  }
  if (!advertisedScenarios) return null;

  for (const scenario of requiredScenarios) {
    if (!advertisedScenarios.has(scenario)) {
      return {
        scenario,
        detail: `list_scenarios did not advertise required seed scenario "${scenario}".`,
      };
    }
  }
  return null;
}

function controllerScenarioSetFromOptions(options: StoryboardRunOptions): Set<string> | null {
  const capabilities = options._controllerCapabilities;
  if (capabilities?.detected !== true) return null;
  return new Set((capabilities.scenarios as readonly string[]).filter(scenario => typeof scenario === 'string'));
}

async function fetchControllerScenarioSet(
  client: TestClient,
  options: StoryboardRunOptions,
  seedContext: Record<string, unknown>
): Promise<Set<string> | null> {
  try {
    const raw = await callControllerRaw(client, { scenario: 'list_scenarios', context: seedContext }, options);
    const data = raw.data as { success?: boolean; scenarios?: unknown } | undefined;
    if (!raw.success || data?.success !== true) return null;
    if (Array.isArray(data.scenarios)) {
      return new Set(data.scenarios.filter((scenario): scenario is string => typeof scenario === 'string'));
    }
    if (data.scenarios && typeof data.scenarios === 'object') {
      return new Set(Object.keys(data.scenarios));
    }
    return null;
  } catch {
    return null;
  }
}

const UNSUPPORTED_SEED_DETAIL =
  'Skipped: agent advertised comply_test_controller, but does not implement a seed_* scenario required by this storyboard (`fixture_seed_unsupported`). Storyboard grades not_applicable — the buyer-side flow depends on pre-seeded state the agent has no way to accept.';

function buildUnsupportedSeedResult(
  storyboard: Storyboard,
  calls: Array<{ step_id: string; title: string }>,
  context: StoryboardContext,
  scenario: SeedScenario | BuyerAgentSeedScenario,
  detail?: string
): ControllerSeedingResult {
  const skipDetail = detail
    ? `${UNSUPPORTED_SEED_DETAIL} Unsupported scenario ${scenario}: ${detail}`
    : `${UNSUPPORTED_SEED_DETAIL} Unsupported scenario: ${scenario}.`;
  const steps: StoryboardStepResult[] = calls.map(call => ({
    storyboard_id: storyboard.id,
    step_id: call.step_id,
    phase_id: CONTROLLER_SEEDING_PHASE_ID,
    title: call.title,
    task: 'comply_test_controller',
    passed: true,
    skipped: true,
    skip_reason: 'fixture_seed_unsupported',
    skip: { reason: 'not_applicable', detail: skipDetail },
    duration_ms: 0,
    validations: [],
    context,
    extraction: { path: 'none' },
  }));
  return {
    phase: {
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      phase_title: 'Controller seeding (pre-flight) — agent lacks required seed scenario',
      passed: true,
      steps,
      duration_ms: 0,
    },
    allPassed: true,
    passedCount: 0,
    failedCount: 0,
    seedUnsupported: true,
  };
}

function formatControllerError(
  scenario: SeedScenario | BuyerAgentSeedScenario,
  raw: { success: boolean; error?: string },
  data: { success?: boolean; error?: string; error_detail?: string } | undefined
): string {
  if (data?.error_detail) return data.error ? `${data.error}: ${data.error_detail}` : data.error_detail;
  if (data?.error) return data.error;
  return raw.error ?? `comply_test_controller ${scenario} call failed`;
}

const MISSING_CONTROLLER_DETAIL =
  'Skipped: agent did not advertise comply_test_controller, so fixture seeding (`fixture_seed_unsupported`) cannot run. Storyboard grades not_applicable — the buyer-side flow depends on pre-seeded state the agent has no way to accept.';

function buildMissingControllerResult(
  storyboard: Storyboard,
  calls: Array<{ step_id: string; title: string }>,
  context: StoryboardContext
): ControllerSeedingResult {
  const steps: StoryboardStepResult[] = calls.map(call => ({
    storyboard_id: storyboard.id,
    step_id: call.step_id,
    phase_id: CONTROLLER_SEEDING_PHASE_ID,
    title: call.title,
    task: 'comply_test_controller',
    passed: true,
    skipped: true,
    skip_reason: 'missing_test_controller',
    skip: { reason: 'missing_test_controller', detail: MISSING_CONTROLLER_DETAIL },
    duration_ms: 0,
    validations: [],
    context,
    extraction: { path: 'none' },
  }));
  return {
    phase: {
      phase_id: CONTROLLER_SEEDING_PHASE_ID,
      phase_title: 'Controller seeding (pre-flight) — agent lacks comply_test_controller',
      passed: true,
      steps,
      duration_ms: 0,
    },
    allPassed: true,
    passedCount: 0,
    failedCount: 0,
    missingController: true,
  };
}
