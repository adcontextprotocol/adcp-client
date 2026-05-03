/**
 * CI gates for `examples/hello_seller_adapter_guaranteed.ts`.
 *
 * Three independent assertions via the shared helper. The adapter wires
 * `comply_test_controller` so cascade scenarios under `media_buy_seller/*`
 * (driven by `requires_scenarios` in the storyboard yaml) get the
 * controller-driven setup they need. Two remaining failures are filtered
 * out here — each maps to a tracked upstream-fixture follow-up:
 *
 *   - #1415 (targeting_overlay echo on get_media_buys — fixture-side: every
 *     step in the storyboard needs `account.sandbox: true` so the create and
 *     get steps resolve to the same namespace in the adapter's synthesis
 *     branch. SDK-side coverage shipped via createMediaBuyStore + framework
 *     auto-echo, PR #1424.)
 *   - #1417 (HITL media_buy_id capture — fixture-side: upstream
 *     sales_guaranteed storyboard uses `path: media_buy_id` instead of the
 *     `task_completion.media_buy_id` prefix the runner now supports per
 *     PR #1426.)
 *
 * #1416 (NOT_CANCELLABLE state machine) closed in this same PR — adapter
 * now wires `assertMediaBuyTransition` against a local per-buy status tracker.
 *
 * Drop the corresponding entry from `EXPECTED_FAILURES` when each upstream
 * fixture lands. The helper enforces that every entry in the allowlist
 * actually appears in the pre-filter failure set — a spec rename or fixture
 * migration that silently eliminates the gap-failure flips the gate to red
 * so the allowlist stays in sync with reality.
 */

const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Allowlist of (storyboard_id, step_id) pairs whose failures are expected
 * — each maps to a tracked SDK issue. The filter only excludes failures
 * matching one of these pairs; the gate also asserts each pair APPEARED
 * in the pre-filter set (so a future spec rename or runner fix is loud,
 * not silent).
 */
const EXPECTED_FAILURES = [
  {
    storyboard_id: 'sales_guaranteed',
    step_id: 'create_media_buy',
    issue: 'adcp-client#1417',
    reason:
      'HITL completion-artifact capture — SDK runner now supports `task_completion.<path>` ' +
      'context_outputs (PR #1426), but the upstream sales_guaranteed storyboard fixture in ' +
      'adcontextprotocol/adcp still uses bare `path: media_buy_id`. Fixture migration is upstream.',
  },
  {
    storyboard_id: 'media_buy_seller/inventory_list_targeting',
    step_id: 'get_after_create',
    issue: 'adcp-client#1415',
    reason:
      'targeting_overlay echo on get_media_buys — SDK ships createMediaBuyStore + framework ' +
      'auto-echo (PR #1424) and the Hello adapter wires it. Storyboard still fails because the ' +
      "create step's account ref (synthesized by the runner with `sandbox: true`) and the get " +
      "step's account ref (passed through from sample_request without `sandbox`) resolve to " +
      "different sandbox-vs-prod namespaces in the adapter's synthesis-branch resolver. " +
      "Fixture migration upstream (every step's account carries `sandbox: true`) closes it.",
  },
];

function isExpectedFailure(f) {
  return EXPECTED_FAILURES.some(e => e.storyboard_id === (f.storyboard_id || '') && e.step_id === (f.step_id || ''));
}

runHelloAdapterGates({
  suiteName: 'examples/hello_seller_adapter_guaranteed',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_guaranteed.ts'),
  specialism: 'sales-guaranteed',
  storyboardId: 'sales_guaranteed',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_sales_guaranteed_key_do_not_use_in_prod' },
  extraEnv: {
    UPSTREAM_API_KEY: 'mock_sales_guaranteed_key_do_not_use_in_prod',
    // No ADCP_SANDBOX — the framework gate inside
    // `createAdcpServerFromPlatform` admits comply_test_controller via the
    // resolver-stamped `mode: 'sandbox'` on the synthesis branch. Phase 3 of
    // #1435 collapsed the env-fallback admit onto the resolver-mode signal.
  },
  expectedRoutes: [
    'GET /_lookup/network',
    'GET /v1/products',
    'POST /v1/orders',
    'GET /v1/tasks/{id}',
    'GET /v1/orders/{id}',
    'POST /v1/orders/{id}/lineitems',
  ],
  filterFailures: grader => {
    const failures = grader.failures || [];
    // Defensive: every entry in EXPECTED_FAILURES must appear in the
    // pre-filter set. A spec rename or runner fix that eliminates one
    // of these failures should flip the gate red so we know to drop the
    // entry — silent green CI on a stale allowlist hides real regressions.
    for (const expected of EXPECTED_FAILURES) {
      const present = failures.some(f => f.storyboard_id === expected.storyboard_id && f.step_id === expected.step_id);
      assert.ok(
        present,
        `EXPECTED_FAILURES is stale: ${expected.storyboard_id}/${expected.step_id} (${expected.issue}) ` +
          `is no longer reported as a failure. Drop it from the allowlist and re-run; the gate should now ` +
          `pass unfiltered for this case.`
      );
    }
    return failures.filter(f => !isExpectedFailure(f));
  },
  storyboardSummary: `${EXPECTED_FAILURES.length} SDK-side gaps deferred (see ${EXPECTED_FAILURES.map(e => e.issue).join(', ')})`,
});

// Surface assert is a no-op if `node --test` doesn't import it; placed at
// module top-level to keep the gate self-checking even without invocation.
void test;
