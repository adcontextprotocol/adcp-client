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
 * phase, so the seller's catalog is populated ahead of any `create_media_buy`
 * / `sync_creatives` / etc. call that would otherwise fail with
 * `PRODUCT_NOT_FOUND`.
 *
 * Failures here surface as a dedicated synthetic phase (`__controller_seeding__`)
 * so an implementor reading the report can distinguish "setup broke" from
 * "buyer did something wrong" — the runner short-circuits the rest of the
 * phases on any seed failure, emitting a cascade skip with reason
 * `controller_seeding_failed`.
 */

import type { TestClient } from '../client';
import { callControllerRaw } from '../test-controller';
import type {
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
type SeedScenario = 'seed_product' | 'seed_pricing_option' | 'seed_creative' | 'seed_plan' | 'seed_media_buy';

interface SeedCall {
  step_id: string;
  title: string;
  scenario: SeedScenario;
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
  context: StoryboardContext
): Promise<ControllerSeedingResult | null> {
  if (options.skip_controller_seeding === true) return null;
  if (storyboard.prerequisites?.controller_seeding !== true) return null;
  const calls = buildSeedCalls(storyboard.fixtures);
  if (calls.length === 0) return null;

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

  for (const call of calls) {
    const stepStart = Date.now();
    let passed = false;
    let error: string | undefined;

    if (call.authoring_error) {
      error = call.authoring_error;
    } else {
      try {
        const raw = await callControllerRaw(client, { scenario: call.scenario, params: call.params }, options);
        const data = raw.data as { success?: boolean; error?: string; error_detail?: string } | undefined;
        if (raw.success && data?.success === true) {
          passed = true;
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

function formatControllerError(
  scenario: SeedScenario,
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
