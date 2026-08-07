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
  type FixtureResolutionSpec,
} from './fixture-resolution';
import type {
  FixtureResolutionEvidence,
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

interface SeedCall {
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
  discoveryClient: TestClient = client
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
    return runDeclaredFixtureResolution(client, discoveryClient, storyboard, options, context, resolutionCalls);
  }
  if (storyboard.prerequisites?.controller_seeding !== true) return null;

  // If we can see the agent's tool list and `comply_test_controller` is
  // absent, grade as not_applicable rather than issuing calls that are
  // guaranteed to fail on the wire. Spec: `fixture_seed_unsupported` in
  // storyboard-schema.yaml — missing test-controller is a coverage gap, not
  // a setup break. `options.agentTools` is discovered from the agent profile
  // or passed explicitly by the caller; we don't enforce when it's absent
  // because some harnesses skip tool discovery.
  if (options.agentTools && !options.agentTools.includes('comply_test_controller')) {
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

interface DiscoveryCatalog {
  products: Array<Record<string, unknown>>;
  evidence: { page_count: number; product_count: number; cursors: string[] };
}

type DiscoveryCatalogResult =
  | { ok: true; catalog: DiscoveryCatalog }
  | { ok: false; error: string; evidence?: unknown };

/** AdCP 3.2 ordered per-handle seed/discover state machine. */
async function runDeclaredFixtureResolution(
  seedClient: TestClient,
  discoveryClient: TestClient,
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  context: StoryboardContext,
  calls: SeedCall[]
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
  const seedContext = { correlation_id: `${storyboardCorrelationPrefix(storyboard)}--__seeding__` };
  const controllerMissing = options.agentTools?.includes('comply_test_controller') === false;
  let advertisedScenarios = controllerMissing ? new Set<string>() : controllerScenarioSetFromOptions(options);
  let scenarioLookupAttempted = advertisedScenarios !== null;
  const legacyCalls = calls.filter(call => resolutionSpecForCall(call, specByKey) === undefined);
  if (legacyCalls.length > 0) {
    if (controllerMissing) return buildMissingControllerResult(storyboard, legacyCalls, context);
    if (!advertisedScenarios) {
      advertisedScenarios = await fetchControllerScenarioSet(seedClient, options, seedContext);
      scenarioLookupAttempted = true;
    }
    if (advertisedScenarios) {
      const unsupported = legacyCalls.find(call => !call.authoring_error && !advertisedScenarios!.has(call.scenario));
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
  if (needsSeedStrategy && !controllerMissing && !advertisedScenarios && !scenarioLookupAttempted) {
    advertisedScenarios = await fetchControllerScenarioSet(seedClient, options, seedContext);
  }
  let catalogPromise: Promise<DiscoveryCatalogResult> | undefined;
  const catalog = () => (catalogPromise ??= discoverProductCatalog(discoveryClient, options, context));

  let passedCount = 0;
  let failedCount = 0;
  let fixtureUnsatisfied = false;

  for (const call of orderedCalls) {
    const spec = resolutionSpecForCall(call, specByKey);
    // The first production slice only changes product and product-pricing
    // handles. Every other entity keeps the legacy seed-only behavior.
    if (!spec) {
      const legacy = await executeLegacySeedCall(seedClient, storyboard, call, options, context, seedContext);
      if (legacy.step.skip_reason === 'fixture_unsatisfied') {
        return buildUnsupportedSeedResult(storyboard, legacyCalls, context, call.scenario, legacy.step.skip?.detail);
      }
      steps.push(legacy.step);
      if (legacy.step.passed) passedCount++;
      else failedCount++;
      continue;
    }

    const evidence: FixtureResolutionEvidence[] = [];
    const attempted: FixtureResolutionRecord['strategies_attempted'] = [];
    let boundIds: FixtureResolutionRecord['seller_ids'];
    let chosenStrategy: FixtureResolutionRecord['strategy'];
    let failure: string | undefined;
    const stepStart = Date.now();
    const parentStatus = spec.parentProductHandle ? productStatuses.get(spec.parentProductHandle) : undefined;
    const parentUnavailable = spec.entityType === 'product_pricing_option' && parentStatus !== 'resolved';
    if (parentUnavailable) {
      const strategy = spec.strategies[0]!;
      attempted.push(strategy);
      const detail =
        parentStatus === 'failed'
          ? `parent product handle "${spec.parentProductHandle}" failed resolution`
          : `parent product handle "${spec.parentProductHandle}" is unavailable`;
      evidence.push({ strategy, outcome: parentStatus === 'failed' ? 'failed' : 'unavailable', detail });
      if (parentStatus === 'failed') failure = detail;
    }

    for (const strategy of parentUnavailable ? [] : spec.strategies) {
      attempted.push(strategy);
      if (strategy === 'seed') {
        const advertised = advertisedScenarios?.has(call.scenario);
        if (controllerMissing || advertised === false) {
          evidence.push({
            strategy,
            outcome: 'unavailable',
            detail: controllerMissing
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
            options
          );
          const data = raw.data as { success?: boolean; error?: string; error_detail?: string } | undefined;
          if (raw.success && data?.success === true) {
            boundIds = bindSeededFixture(spec, bindings);
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
            evidence.push({ strategy, outcome: 'bound', detail: `${call.scenario} accepted the authored literal id` });
            break;
          }
          if (raw.success && data?.success === false && data.error === 'UNKNOWN_SCENARIO' && advertised !== true) {
            evidence.push({
              strategy,
              outcome: 'unavailable',
              detail: data.error_detail ?? `${call.scenario} returned UNKNOWN_SCENARIO`,
            });
            continue;
          }
          failure = formatControllerError(call.scenario, raw, data);
          evidence.push({ strategy, outcome: 'failed', detail: failure });
          break;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          evidence.push({ strategy, outcome: 'failed', detail: failure });
          break;
        }
      }

      if (strategy === 'discover') {
        if (options.agentTools && !options.agentTools.includes('get_products')) {
          evidence.push({
            strategy,
            outcome: 'unavailable',
            detail: 'agent did not advertise get_products',
          });
          continue;
        }
        const discovered = await catalog();
        if (!discovered.ok) {
          failure = discovered.error;
          evidence.push({ strategy, outcome: 'failed', detail: failure, response: discovered.evidence });
          break;
        }
        const selected = selectDiscoveredFixture(
          spec,
          discovered.catalog.products,
          bindings,
          claimedProducts,
          claimedPricingOptions
        );
        if (!selected.ok) {
          if (selected.failed) {
            failure = selected.detail;
            evidence.push({
              strategy,
              outcome: 'failed',
              detail: selected.detail,
              response: discovered.catalog.evidence,
            });
            break;
          }
          evidence.push({
            strategy,
            outcome: 'unavailable',
            detail: selected.detail,
            response: discovered.catalog.evidence,
          });
          continue;
        }
        boundIds = selected.boundIds;
        chosenStrategy = strategy;
        evidence.push({
          strategy,
          outcome: 'bound',
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
      ...(spec.parentProductHandle && { parent_product_handle: spec.parentProductHandle }),
      requirements: spec.clauses,
      strategies_attempted: attempted,
      status,
      ...(chosenStrategy && { strategy: chosenStrategy }),
      ...(boundIds && { seller_ids: boundIds }),
      evidence,
    };
    records.push(record);

    if (status !== 'unsatisfied') {
      steps.push({
        storyboard_id: storyboard.id,
        step_id: call.step_id,
        phase_id: CONTROLLER_SEEDING_PHASE_ID,
        title: call.title,
        task: chosenStrategy === 'discover' ? 'get_products' : 'comply_test_controller',
        passed: status !== 'failed',
        duration_ms: Date.now() - stepStart,
        validations: [],
        context,
        extraction: { path: 'none' },
        ...(failure && { error: failure }),
      });
    }
    if (status === 'failed') failedCount++;
    else if (status === 'unsatisfied') fixtureUnsatisfied = true;
    else passedCount++;
  }

  const allPassed = failedCount === 0;
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
  };
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
  do {
    if (pageCount >= 1_000) {
      return { ok: false, error: 'fixture discovery pagination exceeded the 1,000-page safety limit' };
    }
    const request: Record<string, unknown> = {
      buying_mode: 'wholesale',
      brand,
      account,
      pagination: { max_results: 100, ...(cursor && { cursor }) },
    };
    let result;
    try {
      result = await executeStoryboardTask(client, 'get_products', request, { signal: options.signal });
    } catch (err) {
      return {
        ok: false,
        error: `fixture discovery transport failure: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    pageCount++;
    if (!result.success) {
      return {
        ok: false,
        error: `fixture discovery get_products rejected: ${result.error ?? result.adcp_error?.code ?? 'unknown error'}`,
        evidence: { page_count: pageCount, request },
      };
    }
    let schemaFailure: string | undefined;
    try {
      const validator = getValidator('get_products', 'sync', options.adcpVersion ?? ADCP_VERSION);
      if (validator) {
        const responseData: unknown = result.data;
        const schemaData = isPlainRecord(responseData)
          ? injectLegacyEnvelopeStatus(responseData, { toolName: 'get_products' })
          : responseData;
        if (!validator(schemaData)) {
          schemaFailure = (validator.errors ?? [])
            .map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
            .join('; ');
        }
      } else {
        const schema = validateResponseSchema('get_products', result.data, options.adcpVersion);
        if (!schema.passed) schemaFailure = schema.error ?? schema.details ?? 'schema validation failed';
      }
    } catch (err) {
      schemaFailure = `response schema unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (schemaFailure) {
      return {
        ok: false,
        error: `fixture discovery returned malformed get_products response: ${schemaFailure}`,
        evidence: { page_count: pageCount },
      };
    }
    if (!isPlainRecord(result.data)) {
      return { ok: false, error: 'fixture discovery returned a non-object get_products response' };
    }
    const pageProducts = result.data.products;
    if (pageProducts !== undefined && !Array.isArray(pageProducts)) {
      return { ok: false, error: 'fixture discovery get_products.products is not an array' };
    }
    for (const product of pageProducts ?? []) {
      if (!isPlainRecord(product) || typeof product.product_id !== 'string' || product.product_id.length === 0) {
        return { ok: false, error: 'fixture discovery returned a product without a non-empty product_id' };
      }
      if (seenProductIds.has(product.product_id)) {
        return {
          ok: false,
          error: `fixture discovery returned duplicate product_id "${product.product_id}"; response order cannot resolve duplicate identities`,
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
            };
          }
          seenPricingIds.add(option.pricing_option_id);
        }
      }
      products.push(product);
      if (products.length > 100_000) {
        return { ok: false, error: 'fixture discovery exceeded the 100,000-product safety limit' };
      }
    }
    const pagination = isPlainRecord(result.data.pagination) ? result.data.pagination : undefined;
    if (pagination?.has_more === true) {
      const next = pagination.cursor;
      if (typeof next !== 'string' || next.length === 0) {
        return { ok: false, error: 'fixture discovery pagination is broken: has_more=true without cursor' };
      }
      if (seenCursors.has(next)) {
        return { ok: false, error: `fixture discovery pagination is broken: repeated cursor "${next}"` };
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
    catalog: { products, evidence: { page_count: pageCount, product_count: products.length, cursors } },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

type SelectedFixture =
  | { ok: true; boundIds: NonNullable<FixtureResolutionRecord['seller_ids']>; detail: string }
  | { ok: false; failed: boolean; detail: string };

function selectDiscoveredFixture(
  spec: FixtureResolutionSpec,
  products: Array<Record<string, unknown>>,
  bindings: FixtureBindingRegistry,
  claimedProducts: Map<string, boolean>,
  claimedPricingOptions: Map<string, boolean>
): SelectedFixture {
  if (spec.entityType === 'product') {
    const candidates = products
      .filter(product => matchesFixtureRequirements(product, spec.clauses))
      .filter(product => identityCanBeClaimed(claimedProducts, product.product_id as string, spec.allowReuse))
      .sort((a, b) => utf8Compare(a.product_id as string, b.product_id as string));
    const selected = candidates[0];
    if (!selected)
      return { ok: false, failed: false, detail: 'no discovered product satisfied the authored requirements' };
    const productId = selected.product_id as string;
    bindings.bindProduct(spec.handle, productId);
    recordIdentityClaim(claimedProducts, productId, spec.allowReuse);
    return {
      ok: true,
      boundIds: { product_id: productId },
      detail: `selected product_id "${productId}" by UTF-8 bytewise order`,
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
      detail: 'no pricing option on the bound product satisfied the authored requirements',
    };
  }
  const pricingOptionId = selected.pricing_option_id as string;
  bindings.bindPricingOption(parentHandle, spec.handle, pricingOptionId);
  recordIdentityClaim(claimedPricingOptions, `${sellerProductId}\0${pricingOptionId}`, spec.allowReuse);
  return {
    ok: true,
    boundIds: { product_id: sellerProductId, pricing_option_id: pricingOptionId },
    detail: `selected pricing option "${sellerProductId}\u0000${pricingOptionId}" by UTF-8 bytewise order`,
  };
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
