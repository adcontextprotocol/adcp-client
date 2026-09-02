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
    ADCP_LIVE_MODE_AUTH_TOKEN: 'demo-acme-outdoor-live-v1',
  },
  expectedRoutes: ['GET /_lookup/network', 'GET /v1/products', 'POST /v1/orders', 'GET /v1/orders/{id}'],
  extraMcpAssertions: [
    {
      label: 'preserves prior package budgets across sequential partial updates',
      run: async ({ callTool }) => {
        const account = {
          brand: { domain: 'acmeoutdoor.example' },
          operator: 'pinnacle-agency.example',
          sandbox: true,
        };
        const created = await callTool('create_media_buy', {
          adcp_version: '3.2-beta.11',
          idempotency_key: 'sequential-budget-create-0001',
          account,
          brand: { domain: 'buyer.example' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
          total_budget: { amount: 1300, currency: 'USD' },
          packages: [
            { product_id: 'acme_dooh_remnant_q2', budget: 600, pricing_option_id: 'cpm_standard' },
            { product_id: 'acme_display_remnant_q2', budget: 700, pricing_option_id: 'cpm_standard' },
          ],
        });
        const buy = created.structuredContent;
        assert.ok(buy?.media_buy_id, JSON.stringify(created));
        assert.equal(buy.packages.length, 2);

        await callTool('update_media_buy', {
          adcp_version: '3.2-beta.11',
          idempotency_key: 'sequential-budget-update-0001',
          account,
          media_buy_id: buy.media_buy_id,
          packages: [{ package_id: buy.packages[0].package_id, budget: 800 }],
        });
        await callTool('update_media_buy', {
          adcp_version: '3.2-beta.11',
          idempotency_key: 'sequential-budget-update-0002',
          account,
          media_buy_id: buy.media_buy_id,
          packages: [{ package_id: buy.packages[1].package_id, budget: 900 }],
        });

        const read = await callTool('get_media_buys', {
          adcp_version: '3.2-beta.11',
          account,
          media_buy_ids: [buy.media_buy_id],
        });
        const projected = read.structuredContent?.media_buys?.[0];
        assert.equal(projected?.total_budget, 1700, JSON.stringify(read));
        assert.deepEqual(
          projected.packages.map(pkg => pkg.budget),
          [800, 900]
        );
      },
    },
    {
      label: 'rejects terminal-state budget updates before upstream PATCH',
      run: async ({ callTool, mockUrl }) => {
        const account = {
          brand: { domain: 'acmeoutdoor.example' },
          operator: 'pinnacle-agency.example',
          sandbox: true,
        };
        const created = await callTool('create_media_buy', {
          adcp_version: '3.2-beta.11',
          idempotency_key: 'terminal-budget-create-0001',
          account,
          brand: { domain: 'buyer.example' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
          packages: [{ product_id: 'acme_dooh_remnant_q2', budget: 600, pricing_option_id: 'cpm_standard' }],
        });
        const buy = created.structuredContent;
        assert.ok(buy?.media_buy_id, JSON.stringify(created));
        await callTool('update_media_buy', {
          adcp_version: '3.2-beta.11',
          idempotency_key: 'terminal-budget-cancel-0001',
          account,
          media_buy_id: buy.media_buy_id,
          canceled: true,
        });
        const before = await fetch(`${mockUrl}/_debug/traffic`).then(response => response.json());
        const rejected = await callTool('update_media_buy', {
          adcp_version: '3.2-beta.11',
          idempotency_key: 'terminal-budget-update-0001',
          account,
          media_buy_id: buy.media_buy_id,
          packages: [{ package_id: buy.packages[0].package_id, budget: 900 }],
        });
        assert.equal(rejected.structuredContent?.adcp_error?.code, 'INVALID_STATE', JSON.stringify(rejected));
        const after = await fetch(`${mockUrl}/_debug/traffic`).then(response => response.json());
        assert.equal(
          after.traffic?.['PATCH /v1/orders/{id}'] ?? 0,
          before.traffic?.['PATCH /v1/orders/{id}'] ?? 0,
          'terminal-state rejection must happen before the upstream financial mutation'
        );
      },
    },
  ],
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
