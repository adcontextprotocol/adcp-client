/**
 * CI gates for `examples/hello_seller_adapter_guaranteed.ts`.
 *
 * Three independent assertions via the shared helper. The adapter wires
 * `comply_test_controller` so cascade scenarios under `media_buy_seller/*`
 * (driven by `requires_scenarios` in the storyboard yaml) get the
 * controller-driven setup they need. Two remaining failures are filtered
 * out here — each maps to a tracked upstream-fixture follow-up:
 *
 * As of AdCP 3.0.6, all known gaps are closed end-to-end:
 *   - #1415 — adcp#3989 (sandbox:true on every account block in
 *     inventory_list_targeting) + SDK PR #1424 (createMediaBuyStore auto-echo)
 *   - #1416 — adcp-client#1480 (assertMediaBuyTransition wired into the
 *     adapter's update_media_buy cancel path)
 *   - #1417 — adcp#3990 (task_completion.media_buy_id path) + SDK PR #1426
 *     (runner-side `task_completion.<path>` context_outputs prefix)
 *
 * The storyboard suite passes unfiltered. The empty allowlist is kept (rather
 * than removed) so the helper's enforcement runs as a no-op — re-introducing
 * a gap in the future is a one-line update.
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
const EXPECTED_FAILURES = [];

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
