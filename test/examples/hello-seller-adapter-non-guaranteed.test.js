/**
 * CI gates for `examples/hello_seller_adapter_non_guaranteed.ts`.
 *
 * Three independent assertions via the shared helper. The adapter wires
 * `comply_test_controller` so cascade scenarios under `media_buy_seller/*`
 * get the controller-driven setup they need. The storyboard runs
 * unfiltered against the full cascade.
 */

const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_FAILURES = [];

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
  filterFailures:
    EXPECTED_FAILURES.length === 0
      ? undefined
      : grader => {
          const failures = grader.failures || [];
          for (const expected of EXPECTED_FAILURES) {
            const present = failures.some(
              f => f.storyboard_id === expected.storyboard_id && f.step_id === expected.step_id
            );
            assert.ok(
              present,
              `EXPECTED_FAILURES is stale: ${expected.storyboard_id}/${expected.step_id} (${expected.issue}) ` +
                `is no longer reported as a failure. Drop it from the allowlist and re-run; the gate should now ` +
                `pass unfiltered for this case.`
            );
          }
          return failures.filter(f => !isExpectedFailure(f));
        },
  storyboardSummary:
    EXPECTED_FAILURES.length === 0
      ? undefined
      : `${EXPECTED_FAILURES.length} SDK-side gaps deferred (see ${EXPECTED_FAILURES.map(e => e.issue).join(', ')})`,
});

void test;
