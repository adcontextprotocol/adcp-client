// Runs the published wholesale-feed storyboards against a real local/test
// training agent. Production intentionally is not the target for stateful
// compliance fixtures.
// ADCP_WHOLESALE_FEED_TRAINING_URL=<local training-agent MCP endpoint>
// ADCP_WHOLESALE_FEED_TRAINING_TOKEN=<local test token>
// ADCP_WHOLESALE_FEED_WIRE_VERSION may select the training deployment's release.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sdk = require('../../dist/lib/index.js');
const { loadStoryboardFile, runStoryboard } = require('../../dist/lib/testing/index.js');

const endpoint = process.env.ADCP_WHOLESALE_FEED_TRAINING_URL;
const token = process.env.ADCP_WHOLESALE_FEED_TRAINING_TOKEN;
const wireAdcpVersion = process.env.ADCP_WHOLESALE_FEED_WIRE_VERSION;
const scenarioIds = [
  'wholesale-feed-products',
  'wholesale-feed-signals',
  'wholesale-feed-product-webhooks',
  'wholesale-feed-signal-webhooks',
  'wholesale-feed-bulk-webhooks',
];

const opts = {
  skip: !endpoint && 'Set ADCP_WHOLESALE_FEED_TRAINING_URL to a local/test training agent',
  timeout: 15 * 60_000,
};

function loadWholesaleStoryboard(scenarioId) {
  return loadStoryboardFile(path.resolve(`compliance/cache/${sdk.ADCP_VERSION}/universal/${scenarioId}.yaml`));
}

test('SDK bundle carries every wholesale-feed integration storyboard', () => {
  const expectedTools = new Map([
    ['wholesale-feed-products', 'get_products'],
    ['wholesale-feed-signals', 'get_signals'],
    ['wholesale-feed-product-webhooks', 'sync_accounts'],
    ['wholesale-feed-signal-webhooks', 'sync_accounts'],
    ['wholesale-feed-bulk-webhooks', 'sync_accounts'],
  ]);
  for (const scenarioId of scenarioIds) {
    const storyboard = loadWholesaleStoryboard(scenarioId);
    assert.equal(storyboard.id, scenarioId.replaceAll('-', '_'));
    assert.ok(storyboard.required_tools.includes(expectedTools.get(scenarioId)));
  }
});

test('published wholesale-feed training storyboards pass every required phase', opts, async t => {
  for (const scenarioId of scenarioIds) {
    await t.test(scenarioId, { timeout: 3 * 60_000 }, async () => {
      const storyboard = loadWholesaleStoryboard(scenarioId);
      assert.equal(storyboard.id, scenarioId.replaceAll('-', '_'));

      const result = await runStoryboard(endpoint, storyboard, {
        protocol: 'mcp',
        auth: token ? { type: 'bearer', token } : undefined,
        adcpVersion: sdk.ADCP_VERSION,
        wireAdcpVersion,
        transport: { allowPrivateIp: true },
        webhook_receiver: { mode: 'loopback_mock' },
        contracts: ['webhook_receiver_runner'],
        sandbox: true,
      });
      const failures = result.phases
        .flatMap(phase => phase.steps)
        .filter(step => !step.passed || step.skipped)
        .map(({ step_id, error, validations, skipped }) => ({ step_id, error, validations, skipped }));

      assert.equal(result.overall_passed, true, JSON.stringify(failures, null, 2));
      assert.deepEqual(failures, []);
    });
  }
});
