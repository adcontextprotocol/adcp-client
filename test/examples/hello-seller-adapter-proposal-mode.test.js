/**
 * CI gates for `examples/hello_seller_adapter_proposal_mode.ts`.
 *
 * The proposal-mode reference adapter — exercises the v1.5 ProposalManager
 * surface end-to-end against the sales-guaranteed mock-server's proposal
 * lifecycle endpoints. Validates the design works when an adapter wraps
 * a real upstream proposal API.
 *
 * Storyboard: `media_buy_seller/proposal_finalize` — brief →
 * brief_with_proposals → refine_proposal → finalize_proposal →
 * accept_proposal (create_media_buy with proposal_id).
 */

const path = require('node:path');
const test = require('node:test');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_FAILURES = [];

function isExpectedFailure(f) {
  return EXPECTED_FAILURES.some(e => e.storyboard_id === (f.storyboard_id || '') && e.step_id === (f.step_id || ''));
}

runHelloAdapterGates({
  suiteName: 'examples/hello_seller_adapter_proposal_mode',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_proposal_mode.ts'),
  specialism: 'sales-guaranteed',
  storyboardId: 'sales_proposal_mode',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_sales_guaranteed_key_do_not_use_in_prod' },
  extraEnv: {
    UPSTREAM_API_KEY: 'mock_sales_guaranteed_key_do_not_use_in_prod',
  },
  expectedRoutes: [
    'GET /_lookup/network',
    'GET /v1/products',
    'POST /v1/proposals',
    'POST /v1/proposals/{id}/refine',
    'POST /v1/proposals/{id}/finalize',
    'POST /v1/orders',
    'POST /v1/orders/{id}/lineitems',
  ],
  filterFailures: grader => (grader.failures || []).filter(f => !isExpectedFailure(f)),
  storyboardSummary: '0 SDK-side gaps — proposal-mode lifecycle wired via v1.5 ProposalManager',
});

void test;
