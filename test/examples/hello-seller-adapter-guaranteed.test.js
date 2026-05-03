/**
 * CI gates for `examples/hello_seller_adapter_guaranteed.ts`.
 *
 * Three independent assertions via the shared helper, with one
 * specialism-specific accommodation: cascade scenarios under
 * `media_buy_seller/*` (driven by `requires_scenarios` in the storyboard
 * yaml) require a `comply_test_controller` wiring that this worked example
 * intentionally omits, so failures are filtered to the main `sales_guaranteed`
 * storyboard. Adopters who need full scenario coverage wire
 * `createComplyController` separately (see `examples/comply-controller-seller.ts`).
 */

const path = require('node:path');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

runHelloAdapterGates({
  suiteName: 'examples/hello_seller_adapter_guaranteed',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_guaranteed.ts'),
  specialism: 'sales-guaranteed',
  storyboardId: 'sales_guaranteed',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_sales_guaranteed_key_do_not_use_in_prod' },
  extraEnv: { UPSTREAM_API_KEY: 'mock_sales_guaranteed_key_do_not_use_in_prod' },
  expectedRoutes: [
    'GET /_lookup/network',
    'GET /v1/products',
    'POST /v1/orders',
    'GET /v1/tasks/{id}',
    'GET /v1/orders/{id}',
    'POST /v1/orders/{id}/lineitems',
  ],
  // Filter to main-storyboard failures only. Cascade scenarios under
  // `media_buy_seller/*` need comply_test_controller wiring that this
  // worked example doesn't include; their failures are documented in the
  // file header rather than gated here.
  filterFailures: grader => (grader.failures || []).filter(f => f.storyboard_id === 'sales_guaranteed'),
  storyboardSummary:
    'cascade scenarios under media_buy_seller/* require comply_test_controller and are not exercised here',
});
