const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder');
const { applyBrandInvariant } = require('../../dist/lib/testing/storyboard/account-policy');

const authoredBrand = { domain: 'acmeoutdoor.example' };
const authoredAccount = { brand: authoredBrand, operator: 'pinnacle-agency.example', sandbox: true };
function storyboard() {
  return {
    id: 'authored_buy_brand',
    title: 'Authored buy brand',
    version: '1.0',
    context: { account: structuredClone(authoredAccount) },
    phases: [
      {
        id: 'buy',
        title: 'Buy',
        steps: [
          {
            id: 'create',
            title: 'Create a fixture-backed buy',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {
              brand: structuredClone(authoredBrand),
              account: structuredClone(authoredAccount),
              start_time: 'asap',
              end_time: '2099-06-30T23:59:59Z',
              packages: [{ product_id: 'display-auction', pricing_option_id: 'cpm', budget: 10000, bid_price: 6 }],
            },
          },
        ],
      },
    ],
  };
}
for (const runBrand of [undefined, { domain: 'selected-run-brand.example' }]) {
  test(
    runBrand
      ? 'an explicit run brand still overrides the authored buy and account together'
      : 'buyer request enrichment preserves the authored brand when no run-brand override is configured',
    async () => {
      const source = storyboard();
      const before = structuredClone(source);
      const options = { adcpVersion: '3.1.31', sandbox: true, ...(runBrand && { brand: runBrand }) };
      const step = source.phases[0].steps[0];
      const request = applyBrandInvariant(buildRequest(step, source.context, options), options, step.task);
      assert.deepEqual(request.brand, runBrand ?? authoredBrand);
      assert.deepEqual(request.account.brand, runBrand ?? authoredBrand);
      assert.equal(request.account.operator, authoredAccount.operator);
      assert.equal(request.account.sandbox, true);
      assert.deepEqual(
        request.packages.map(pkg => [pkg.product_id, pkg.pricing_option_id, pkg.bid_price]),
        [['display-auction', 'cpm', 6]]
      );
      assert.deepEqual(source, before, 'request enrichment does not rewrite the authored fixture');
    }
  );
}
