/**
 * CI gates for `examples/hello_seller_adapter_non_guaranteed.ts`.
 *
 * Three independent assertions via the shared helper. The adapter wires
 * `comply_test_controller` so cascade scenarios under `media_buy_seller/*`
 * get the controller-driven setup they need. One expected-failure entry
 * remains:
 *
 *   - #1416 (NOT_CANCELLABLE state machine export)
 *
 * Drop the corresponding entry from `EXPECTED_FAILURES` when each issue
 * lands. The helper enforces that every entry in the allowlist actually
 * appears in the pre-filter failure set — a spec rename that silently
 * eliminates the gap-failure flips the gate to red so the allowlist
 * stays in sync with reality.
 */

const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_FAILURES = [
  {
    storyboard_id: 'media_buy_seller/invalid_transitions',
    step_id: 'second_cancel',
    issue: 'adcp-client#1416',
    reason: 'NOT_CANCELLABLE on re-cancel — needs SDK-exported MEDIA_BUY_TRANSITIONS / assertMediaBuyTransition',
  },
];

function isExpectedFailure(f) {
  return EXPECTED_FAILURES.some(e => e.storyboard_id === (f.storyboard_id || '') && e.step_id === (f.step_id || ''));
}

runHelloAdapterGates({
  suiteName: 'examples/hello_seller_adapter_non_guaranteed',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_non_guaranteed.ts'),
  specialism: 'sales-non-guaranteed',
  storyboardId: 'sales_non_guaranteed',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_sales_non_guaranteed_key_do_not_use_in_prod' },
  extraEnv: {
    UPSTREAM_API_KEY: 'mock_sales_non_guaranteed_key_do_not_use_in_prod',
  },
  expectedRoutes: ['GET /_lookup/network', 'GET /v1/products', 'POST /v1/orders', 'GET /v1/orders/{id}'],
  filterFailures: grader => {
    const failures = grader.failures || [];
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

void test;
