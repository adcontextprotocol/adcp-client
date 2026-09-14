// Run against the actual adcp training seller in local/test mode (production
// intentionally disables its process-local change feed). No replacement seller.
// ADCP_ACCOUNT_FEED_TRAINING_URL=http://127.0.0.1:4781/api/training-agent/sales/mcp
// ADCP_ACCOUNT_FEED_TRAINING_TOKEN=<local test token>
// ADCP_ACCOUNT_FEED_WIRE_VERSION may select the training deployment's release.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const sdk = require('../../dist/lib/index.js');
const { loadStoryboardFile, runStoryboard } = require('../../dist/lib/testing/index.js');
const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');

const endpoint = process.env.ADCP_ACCOUNT_FEED_TRAINING_URL;
const token = process.env.ADCP_ACCOUNT_FEED_TRAINING_TOKEN;
const wireAdcpVersion = process.env.ADCP_ACCOUNT_FEED_WIRE_VERSION;
const storyboardFile = path.resolve(
  `compliance/cache/${sdk.ADCP_VERSION}/protocols/media-buy/scenarios/account_change_feed.yaml`
);
const opts = {
  skip: !endpoint && 'Set ADCP_ACCOUNT_FEED_TRAINING_URL to a local/test training seller',
  timeout: 180000,
};

async function connectTrainingAgent() {
  const client = new Client({ name: 'account-feed-adopter-integration', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    })
  );
  const agent = sdk.AgentClient.fromMCPClient(client, {
    agentName: 'training-seller',
    adcpVersion: sdk.ADCP_VERSION,
    wireAdcpVersion,
    validateFeatures: false,
    validation: { requests: 'strict', responses: 'strict' },
  });
  return { client, agent };
}

async function removeSubscriber(agent, subscriberId) {
  const account = { account_id: 'acc_luma_shared' };
  const listed = await agent.listAccounts({ account });
  assert.equal(listed.success, true);
  const configs = listed.data.accounts.find(row => row.account_id === account.account_id)?.notification_configs;
  if (configs?.some(config => config.subscriber_id === subscriberId)) {
    const result = await agent.syncAccounts({
      accounts: [{ account, notification_configs: configs.filter(config => config.subscriber_id !== subscriberId) }],
    });
    assert.equal(result.success, true);
  }
}

test('merged #6811 published training storyboard passes every required phase', opts, async () => {
  // The generic runner resets named UUIDs at phase boundaries. This scenario
  // deliberately refers to one creative across phases; instantiate its named
  // fixtures once, keeping all published requests and assertions intact.
  const ids = new Map();
  const storyboard = JSON.parse(JSON.stringify(loadStoryboardFile(storyboardFile)), (_key, value) => {
    if (typeof value !== 'string' || !value.startsWith('$generate:uuid_v4#')) return value;
    if (!ids.has(value)) ids.set(value, randomUUID());
    return ids.get(value);
  });
  assert.equal(storyboard.id, 'media_buy_seller/account_change_feed');
  let result;
  try {
    result = await runStoryboard(endpoint, storyboard, {
      protocol: 'mcp',
      auth: token ? { type: 'bearer', token } : undefined,
      adcpVersion: sdk.ADCP_VERSION,
      wireAdcpVersion,
      transport: { allowPrivateIp: true },
      webhook_receiver: { mode: 'loopback_mock' },
      contracts: ['webhook_receiver_runner'],
      sandbox: true,
    });
  } finally {
    const { client, agent } = await connectTrainingAgent();
    try {
      await removeSubscriber(agent, 'account-change-runner');
    } finally {
      await client.close();
    }
  }
  const failures = result.phases.flatMap(phase => phase.steps).filter(step => !step.passed || step.skipped);
  assert.equal(
    result.overall_passed,
    true,
    JSON.stringify(
      failures.map(({ step_id, error, validations, skipped }) => ({ step_id, error, validations, skipped })),
      null,
      2
    )
  );
  assert.equal(
    failures.length,
    0,
    JSON.stringify(
      failures.map(({ step_id, error, validations, skipped }) => ({ step_id, error, validations, skipped })),
      null,
      2
    )
  );
});

test('SDK bootstrap, wake-up parsing, authoritative repair and expiry use the training scenario', opts, async () => {
  const { client, agent } = await connectTrainingAgent();
  const receiver = await createWebhookReceiver();
  const account = { account_id: 'acc_luma_shared' };
  const subscriberId = `sdk-${randomUUID()}`;
  const resourceTypes = ['creative'];
  let checkpoint;
  const repaired = [];
  const rebuilds = [];
  try {
    const caps = await agent.getCapabilities();
    assert.equal(
      caps.account?.changeFeed?.supported,
      true,
      'A configured integration target must advertise support; never skip'
    );
    const listed = await agent.listAccounts({ account });
    assert.equal(listed.success, true, JSON.stringify(listed));
    const current = listed.data.accounts.find(row => row.account_id === account.account_id);
    assert.ok(current, 'shared account must be readable');
    const registered = await agent.syncAccounts(
      sdk.buildAccountChangeSubscriptionRequest({
        account,
        currentConfigs: current.notification_configs ?? [],
        subscriber: { subscriber_id: subscriberId, url: `${receiver.base_url}/step/account_feed/wakeup`, active: true },
      })
    );
    assert.equal(registered.success, true, JSON.stringify(registered));
    assert.ok(registered.data.accounts[0].notification_configs.some(config => config.subscriber_id === subscriberId));

    const bootstrap = async ({ reason }) => {
      const snapshot = await agent.listCreatives({ account, pagination: { max_results: 100 } });
      assert.equal(snapshot.success, true, JSON.stringify(snapshot));
      rebuilds.push(reason);
    };
    const drain = async () => {
      for await (const page of sdk.streamAccountChanges(agent, {
        account,
        cursor: checkpoint,
        resourceTypes,
        bootstrap,
      })) {
        for (const change of page.changes) {
          assert.equal(change.resource.account_id, account.account_id);
          assert.equal(change.repair.task, 'list_creatives');
          const read = await agent.listCreatives({ account, filters: { creative_ids: [change.resource.resource_id] } });
          assert.equal(read.success, true, JSON.stringify(read));
          repaired.push({ change, current: read.data.creatives[0] });
        }
        await page.acknowledge(async cursor => {
          checkpoint = cursor;
        });
      }
    };
    await drain();
    assert.deepEqual(rebuilds, ['initial']);
    assert.ok(checkpoint);

    const storyboard = loadStoryboardFile(storyboardFile);
    const steps = storyboard.phases.flatMap(phase => phase.steps);
    const seed = structuredClone(steps.find(step => step.id === 'seed_connected_creative').sample_request);
    const creativeId = randomUUID();
    seed.params.creative_id = creativeId;
    seed.adcp_version = wireAdcpVersion ?? sdk.toReleasePrecisionWire(sdk.ADCP_VERSION);
    const seeded = await client.callTool({ name: 'comply_test_controller', arguments: seed });
    assert.equal(seeded.structuredContent.success, true, JSON.stringify(seeded));
    const delivered = await receiver.wait(
      {
        body: {
          notification_type: 'account.change_recorded',
          subscriber_id: subscriberId,
          'resource.resource_id': creativeId,
        },
      },
      30000
    );
    assert.notEqual(delivered.timed_out, true);
    const notice = sdk.parseAccountChangeNotification(delivered.webhook.raw_body, {
      accountId: account.account_id,
      subscriberId,
    });
    assert.equal(notice.resource.resource_id, creativeId);
    assert.ok(delivered.webhook.headers['signature'], 'training seller signs the wake-up');
    await drain();
    const repair = repaired.find(entry => entry.change.change_id === notice.changeId);
    assert.ok(repair);
    assert.equal(repair.current.status, 'approved');
    sdk.parseAccountChangeNotification(delivered.webhook.raw_body, {
      accountId: account.account_id,
      subscriberId,
      change: repair.change,
    });

    const update = structuredClone(steps.find(step => step.id === 'force_connected_creative_rejection').sample_request);
    update.params.creative_id = creativeId;
    update.adcp_version = seed.adcp_version;
    const updated = await client.callTool({ name: 'comply_test_controller', arguments: update });
    assert.equal(updated.structuredContent.success, true, JSON.stringify(updated));
    await drain();
    assert.ok(
      repaired.some(entry => entry.change.resource.resource_id === creativeId && entry.current.status === 'rejected')
    );

    const expire = structuredClone(steps.find(step => step.id === 'expire_authorization_scope').sample_request);
    expire.adcp_version = seed.adcp_version;
    const expired = await client.callTool({ name: 'comply_test_controller', arguments: expire });
    assert.equal(expired.structuredContent.success, true, JSON.stringify(expired));
    await drain();
    assert.deepEqual(rebuilds, ['initial', 'cursor_expired']);
  } finally {
    try {
      await removeSubscriber(agent, subscriberId);
    } finally {
      await client.close();
      await receiver.close();
    }
  }
});
