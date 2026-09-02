process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { connect } = require('node:net');
const path = require('node:path');
const { createMCPClient } = require('../../dist/lib/protocols');

const ROOT = path.resolve(__dirname, '../..');

function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('starter did not begin listening'));
        else setTimeout(attempt, 75);
      });
    };
    attempt();
  });
}

test('compact starter enforces pricing, account, and terminal lifecycle boundaries over MCP', async t => {
  const port = 36_000 + (process.pid % 2_000);
  const token = 'starter-test-token';
  const accountId = 'starter-account';
  const product = {
    product_id: 'display-product',
    name: 'Display product',
    description: 'Real test-owned catalog input',
    format_options: [
      { format_option_id: 'display-300x250', format_kind: 'image', params: { width: 300, height: 250 } },
    ],
    pricing_options: [{ pricing_option_id: 'display-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
    measurement_terms: {
      billing_measurement: { vendor: { domain: 'measurement.example' }, max_variance_percent: 10 },
      makegood_policy: { available_remedies: ['credit'] },
    },
    performance_standards: [
      { metric: 'viewability', threshold: 0.7, standard: 'mrc', vendor: { domain: 'measurement.example' } },
    ],
  };
  const euroProduct = {
    ...product,
    product_id: 'euro-display-product',
    pricing_options: [{ pricing_option_id: 'euro-display-cpm', pricing_model: 'cpm', currency: 'EUR', fixed_price: 6 }],
  };
  let stderr = '';
  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['examples/seller-3.2-starter.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ADCP_AUTH_TOKEN: token,
      ADCP_ACCOUNT_ID: accountId,
      PRODUCT_CATALOG_JSON: JSON.stringify([product, euroProduct]),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => (stderr += chunk));
  t.after(() => child.kill('SIGTERM'));
  await waitForPort(port).catch(error => {
    throw new Error(`${error.message}: ${stderr}`);
  });

  const client = createMCPClient(`http://127.0.0.1:${port}/mcp`, token, undefined, undefined, undefined, {
    allowPrivateIp: true,
  });
  const account = { account_id: accountId };
  const listed = await client.callTool('list_products', { account, brand: { domain: 'advertiser.example' } });
  assert.notEqual(listed.isError, true, JSON.stringify(listed));
  assert.equal(listed.structuredContent.products[0].product_id, product.product_id);
  const feedVersion = listed.structuredContent.feed_version;

  const invalidPricing = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [{ product_id: product.product_id, pricing_option_id: 'foreign-price', budget: 1000 }],
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'invalid-pricing-0001',
  });
  assert.equal(invalidPricing.isError, true);
  assert.equal(invalidPricing.structuredContent.adcp_error.code, 'INVALID_PRICING_OPTION');

  const divergentTerms = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [
      {
        product_id: product.product_id,
        pricing_option_id: 'display-cpm',
        budget: 1000,
        measurement_terms: {
          billing_measurement: { vendor: { domain: 'measurement.example' }, max_variance_percent: 11 },
          makegood_policy: { available_remedies: ['credit'] },
        },
      },
    ],
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'divergent-terms-0001',
  });
  assert.equal(divergentTerms.isError, true);
  assert.equal(divergentTerms.structuredContent.adcp_error.code, 'TERMS_REJECTED');

  const unresolvedFormat = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [
      {
        product_id: product.product_id,
        pricing_option_id: 'display-cpm',
        budget: 1000,
        format_option_refs: [{ scope: 'product', format_option_id: 'missing-format' }],
      },
    ],
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'unresolved-format-0001',
  });
  assert.equal(unresolvedFormat.isError, true);
  assert.equal(unresolvedFormat.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');

  const mixedCurrency = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [
      { product_id: product.product_id, pricing_option_id: 'display-cpm', budget: 1000 },
      { product_id: euroProduct.product_id, pricing_option_id: 'euro-display-cpm', budget: 1000 },
    ],
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'mixed-currency-00001',
  });
  assert.equal(mixedCurrency.isError, true);
  assert.equal(mixedCurrency.structuredContent.adcp_error.code, 'TERMS_REJECTED');

  const wrongBudgetCurrency = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [{ product_id: product.product_id, pricing_option_id: 'display-cpm', budget: 1000 }],
    total_budget: { amount: 1000, currency: 'EUR' },
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'wrong-budget-currency-1',
  });
  assert.equal(wrongBudgetCurrency.isError, true);
  assert.equal(wrongBudgetCurrency.structuredContent.adcp_error.code, 'TERMS_REJECTED');

  const mismatchedBudget = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [{ product_id: product.product_id, pricing_option_id: 'display-cpm', budget: 1000 }],
    total_budget: { amount: 1200, currency: 'USD' },
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'mismatched-budget-0001',
  });
  assert.equal(mismatchedBudget.isError, true);
  assert.equal(mismatchedBudget.structuredContent.adcp_error.code, 'TERMS_REJECTED');
  assert.equal(mismatchedBudget.structuredContent.adcp_error.field, 'total_budget.amount');

  const unsupportedDeliveryControl = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [{ product_id: product.product_id, pricing_option_id: 'display-cpm', budget: 1000 }],
    pacing: 'even',
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'unsupported-pacing-001',
  });
  assert.equal(unsupportedDeliveryControl.isError, true);
  assert.equal(unsupportedDeliveryControl.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
  assert.equal(unsupportedDeliveryControl.structuredContent.adcp_error.field, 'pacing');

  const unsupportedPurchaseControl = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [
      { product_id: product.product_id, pricing_option_id: 'display-cpm', budget: 1000, impressions: 200000 },
    ],
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'unsupported-impressions-1',
  });
  assert.equal(unsupportedPurchaseControl.isError, true);
  assert.equal(unsupportedPurchaseControl.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
  assert.equal(unsupportedPurchaseControl.structuredContent.adcp_error.field, 'purchases[0].impressions');

  const pausedBuy = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [{ product_id: product.product_id, pricing_option_id: 'display-cpm', budget: 500 }],
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    paused: true,
    idempotency_key: 'paused-purchase-00001',
  });
  assert.notEqual(pausedBuy.isError, true, JSON.stringify(pausedBuy));
  assert.equal(pausedBuy.structuredContent.media_buy_status, 'paused');
  assert.deepEqual(
    pausedBuy.structuredContent.available_actions.map(action => action.action),
    ['resume']
  );

  const bought = await client.callTool('buy_products', {
    account,
    brand: { domain: 'advertiser.example' },
    feed_version: feedVersion,
    purchases: [
      {
        product_id: product.product_id,
        pricing_option_id: 'display-cpm',
        budget: 1000,
        context: { line_item: 'buyer-line-1' },
      },
    ],
    total_budget: { amount: 1000, currency: 'USD' },
    purchase_order_ref: 'PO-STARTER-1',
    context: { campaign: 'buyer-campaign-1' },
    start_time: 'asap',
    end_time: '2026-12-31T23:59:59Z',
    idempotency_key: 'valid-purchase-000001',
  });
  assert.notEqual(bought.isError, true, JSON.stringify(bought));
  const acceptedPurchase = bought.structuredContent.accepted_proposal.commercial_terms.purchases[0];
  assert.equal(bought.structuredContent.accepted_proposal.commercial_terms.source_feed_version, feedVersion);
  assert.deepEqual(bought.structuredContent.accepted_proposal.commercial_terms.total_budget, {
    amount: 1000,
    currency: 'USD',
  });
  assert.equal(bought.structuredContent.accepted_proposal.commercial_terms.purchase_order_ref, 'PO-STARTER-1');
  assert.deepEqual(acceptedPurchase.measurement_terms, product.measurement_terms);
  assert.deepEqual(acceptedPurchase.performance_standards, product.performance_standards);
  assert.deepEqual(
    bought.structuredContent.available_actions.map(action => action.action),
    ['pause']
  );
  const invalidResume = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: bought.structuredContent.revision,
    paused: false,
    idempotency_key: 'invalid-resume-000001',
  });
  assert.equal(invalidResume.isError, true);
  assert.equal(invalidResume.structuredContent.adcp_error.code, 'ACTION_NOT_ALLOWED');
  assert.equal(invalidResume.structuredContent.adcp_error.details.attempted_action, 'resume');
  assert.equal(invalidResume.structuredContent.adcp_error.details.reason, 'wrong_status');
  const paused = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: bought.structuredContent.revision,
    paused: true,
    idempotency_key: 'pause-purchase-000001',
  });
  assert.notEqual(paused.isError, true, JSON.stringify(paused));
  assert.equal(paused.structuredContent.media_buy_status, 'paused');
  assert.deepEqual(
    paused.structuredContent.available_actions.map(action => action.action),
    ['resume']
  );
  const noChange = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    idempotency_key: 'no-change-purchase-0001',
  });
  assert.equal(noChange.isError, true);
  assert.equal(noChange.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
  const invalidPause = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    paused: true,
    idempotency_key: 'invalid-pause-0000001',
  });
  assert.equal(invalidPause.isError, true);
  assert.equal(invalidPause.structuredContent.adcp_error.code, 'ACTION_NOT_ALLOWED');
  const termsEdit = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    name: 'Commercial change',
    idempotency_key: 'edit-purchase-0000001',
  });
  assert.equal(termsEdit.isError, true);
  assert.equal(termsEdit.structuredContent.adcp_error.code, 'ACTION_NOT_ALLOWED');
  assert.equal(termsEdit.structuredContent.adcp_error.details.attempted_action, 'update_name');
  const budgetEdit = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    total_budget: { amount: 1500, currency: 'USD' },
    idempotency_key: 'budget-purchase-0001',
  });
  assert.equal(budgetEdit.isError, true);
  assert.equal(budgetEdit.structuredContent.adcp_error.code, 'REQUOTE_REQUIRED');
  assert.equal(budgetEdit.structuredContent.adcp_error.details.envelope_field, 'total_budget');
  const webhookEdit = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    reporting_webhook: {
      url: 'https://buyer.example/reporting',
      reporting_frequency: 'daily',
      authentication: { schemes: ['HMAC-SHA256'], credentials: 'test-owned-placeholder-secret-32-bytes' },
    },
    idempotency_key: 'webhook-purchase-0001',
  });
  assert.equal(webhookEdit.isError, true);
  assert.equal(webhookEdit.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
  assert.equal(webhookEdit.structuredContent.adcp_error.field, 'reporting_webhook');
  const afterRejectedEdit = await client.callTool('get_media_buys', {
    account,
    media_buy_ids: [bought.structuredContent.media_buy_id],
  });
  assert.equal(afterRejectedEdit.structuredContent.media_buys[0].status, 'paused');
  assert.deepEqual(afterRejectedEdit.structuredContent.media_buys[0].context, { campaign: 'buyer-campaign-1' });
  assert.deepEqual(afterRejectedEdit.structuredContent.media_buys[0].packages[0].context, {
    line_item: 'buyer-line-1',
  });
  const canceled = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    canceled: true,
    idempotency_key: 'cancel-purchase-00001',
  });
  assert.equal(canceled.isError, true);
  assert.equal(canceled.structuredContent.adcp_error.code, 'ACTION_NOT_ALLOWED');
  assert.equal(canceled.structuredContent.adcp_error.details.attempted_action, 'cancel');
  assert.deepEqual(canceled.structuredContent.adcp_error.details.currently_available_actions, [
    { task: 'control_media_buy', action: 'resume', mode: 'self_serve' },
  ]);
  const resumed = await client.callTool('control_media_buy', {
    account,
    media_buy_id: bought.structuredContent.media_buy_id,
    revision: paused.structuredContent.revision,
    paused: false,
    idempotency_key: 'resume-purchase-00001',
  });
  assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
  assert.equal(resumed.structuredContent.media_buy_status, 'active');

  const foreignAccount = await client.callTool('list_products', {
    account: { account_id: 'foreign-account' },
    brand: { domain: 'advertiser.example' },
  });
  assert.equal(foreignAccount.isError, true);
  assert.equal(foreignAccount.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
});
