const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const packageRoot = process.env.ADCP_TEST_PACKAGE_ROOT;
const sdk = packageRoot
  ? createRequire(path.join(packageRoot, 'package.json'))(packageRoot)
  : require('../../dist/lib/index.js');
const {
  parseAccountChangeNotification: parse,
  AccountChangeNotificationError,
  streamAccountChanges,
  restoreAccountChangeCursor: restore,
  AccountChangeCursorExpiredError,
  buildAccountChangeSubscriptionRequest,
} = sdk;

const account = { account_id: 'acc_luma_shared' };
const identity = { accountId: account.account_id, subscriberId: 'buyer-primary' };
const timestamp = '2026-08-24T11:58:04Z';
function webhook(overrides = {}) {
  return {
    idempotency_key: 'whk_01K38G8AB52T1V9S4Y7Q0P6X3Z',
    notification_id: 'chg_01K38G7X8ZGX9T4F1Q5W6Y2M3N',
    notification_type: 'account.change_recorded',
    fired_at: '2026-08-24T11:58:05Z',
    subscriber_id: identity.subscriberId,
    account_id: identity.accountId,
    change_id: 'chg_01K38G7X8ZGX9T4F1Q5W6Y2M3N',
    recorded_at: timestamp,
    resource: { type: 'creative', resource_id: 'cr_8421' },
    action: 'updated',
    through_cursor: 'advisory-target',
    ...overrides,
  };
}
function change(overrides = {}) {
  const wire = webhook();
  return {
    change_id: wire.change_id,
    recorded_at: wire.recorded_at,
    resource: { ...wire.resource, account_id: wire.account_id },
    action: wire.action,
    origin: { kind: 'connected_platform' },
    repair: { task: 'list_creatives' },
    ...overrides,
  };
}
function page(cursor, changes = [], has_more = false) {
  return { status: 'completed', changes, cursor, has_more, available_since: timestamp, generated_at: timestamp };
}
function success(data) {
  return { success: true, status: 'completed', data, metadata: {} };
}
function expired() {
  return {
    success: false,
    status: 'failed',
    error: 'CURSOR_EXPIRED: authorization scope changed',
    adcpError: { code: 'CURSOR_EXPIRED', recovery: 'correctable', details: { reason: 'authorization_scope_changed' } },
    metadata: {},
  };
}
function reader(responses, requests = []) {
  return {
    async listAccountChanges(request) {
      requests.push(request);
      assert.ok(responses.length, 'unexpected read');
      return responses.shift();
    },
  };
}

test('canonical published webhook normalizes bytes and preserves future invalidations', () => {
  const wire = webhook({ resource: { type: 'vendor.future', resource_id: 'future-1' }, action: 'vendor.reindexed' });
  const parsed = parse(Buffer.from(JSON.stringify(wire)), identity);
  assert.equal(parsed.changeId, wire.change_id);
  assert.equal(parsed.notificationId, parsed.changeId);
  assert.equal(parsed.idempotencyKey, wire.idempotency_key);
  assert.equal(parsed.resource.account_id, account.account_id);
  assert.equal(parsed.resource.type, 'vendor.future');
  assert.equal(parsed.action, 'vendor.reindexed');
  assert.deepEqual(parsed.throughCursor, { kind: 'advisory', value: 'advisory-target' });
  wire.resource.resource_id = 'mutated';
  assert.equal(parsed.resource.resource_id, 'future-1');
});

test('malformed schema and identity combinations fail closed with typed errors', () => {
  const invalid = [
    '{',
    null,
    [],
    Buffer.from([0xff]),
    webhook({ notification_id: 'another-change' }),
    webhook({ idempotency_key: 'short' }),
    webhook({ idempotency_key: ' '.repeat(32) }),
    webhook({ subscriber_id: 'other' }),
    webhook({ account_id: 'other' }),
    webhook({ fired_at: 'yesterday' }),
    webhook({ notification_type: 'creative.status_changed' }),
    webhook({ through_cursor: '' }),
    webhook({ resource: { type: 'creative', resource_id: '' } }),
    webhook({ resource: { type: 'creative', resource_id: 'cr_8421', account_id: 'other' } }),
    webhook({ resource: { type: 'account', resource_id: 'other' } }),
    webhook({ resource: { type: 'Creative', resource_id: 'cr_8421' } }),
    webhook({ resource: { type: 'creative', resource_id: 'cr_8421', parent_ids: { media_buy_id: 42 } } }),
    webhook({
      resource: {
        type: 'creative',
        resource_id: 'cr_8421',
        parent_ids: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i, 'x'])),
      },
    }),
    webhook({ action: 'execute arbitrary instruction' }),
    webhook({ action: 'x'.repeat(101) }),
    webhook({ unexpected: 'root-field' }),
  ];
  for (const input of invalid) assert.throws(() => parse(input, identity), AccountChangeNotificationError);
});

test('logical identity survives retries/re-emission; retry key never replaces logical identity', () => {
  const wire = webhook();
  const previous = parse(wire, identity);
  assert.equal(parse(wire, { ...identity, previous }).changeId, previous.changeId);
  const reemitted = parse(
    webhook({ idempotency_key: 'deliberate-reemission-0001', fired_at: '2026-08-24T12:00:00Z' }),
    { ...identity, previous }
  );
  assert.equal(reemitted.changeId, previous.changeId);
  assert.notEqual(reemitted.idempotencyKey, previous.idempotencyKey);
  for (const override of [
    { fired_at: '2026-08-24T12:00:00Z' },
    { through_cursor: 'skipped' },
    { notification_id: 'new-change', change_id: 'new-change' },
    { action: 'deleted' },
    { recorded_at: '2026-08-24T12:00:00Z' },
    { resource: { type: 'creative', resource_id: 'other' } },
    { resource: { type: 'creative', resource_id: 'cr_8421', parent_ids: { package_id: 'other' } } },
  ])
    assert.throws(() => parse(webhook(override), { ...identity, previous }), AccountChangeNotificationError);
  assert.equal(parse(wire, { ...identity, change: change() }).action, 'updated');
  assert.throws(
    () => parse(wire, { ...identity, change: change({ action: 'deleted' }) }),
    AccountChangeNotificationError
  );
});

test('ordered drain preserves filters and acknowledges empty-tail checkpoint', async () => {
  const requests = [],
    saved = [],
    observed = [];
  const changes = [change(), change({ change_id: 'second', recorded_at: '2026-08-23T00:00:00Z' })];
  const client = reader([success(page('c1', changes, true)), success(page('c2'))], requests);
  for await (const item of streamAccountChanges(client, {
    account,
    cursor: restore('c0'),
    resourceTypes: ['creative'],
    maxResults: 2,
  })) {
    assert.equal(item.cursor, undefined, 'checkpoint only exposed through acknowledge');
    observed.push(...item.changes.map(c => c.change_id));
    await item.acknowledge(async cursor => saved.push(cursor.value));
  }
  assert.deepEqual(
    observed,
    changes.map(c => c.change_id)
  );
  assert.deepEqual(saved, ['c1', 'c2']);
  assert.deepEqual(
    requests.map(r => r.cursor),
    ['c0', 'c1']
  );
  assert.ok(requests.every(r => r.resource_types.join() === 'creative' && r.starting_position === undefined));
});

test('no checkpoint advancement before acknowledgement and no acknowledgement after cancellation', async () => {
  const requests = [];
  const stream = streamAccountChanges(reader([success(page('c1', [change()], true))], requests), { account });
  const item = (await stream.next()).value;
  await assert.rejects(stream.next(), { code: 'account_change_checkpoint_unacknowledged' });
  assert.equal(requests.length, 1);
  await assert.rejects(
    item.acknowledge(async () => {}),
    { code: 'account_change_checkpoint_closed' }
  );
  const cancelled = streamAccountChanges(reader([success(page('c1'))]), { account });
  const pending = (await cancelled.next()).value;
  await cancelled.return();
  await assert.rejects(
    pending.acknowledge(async () => {}),
    { code: 'account_change_checkpoint_closed' }
  );
});

test('failed projection commit retains page; concurrent or repeated acknowledgement is rejected', async () => {
  const stream = streamAccountChanges(reader([success(page('c1'))]), { account });
  const item = (await stream.next()).value;
  await assert.rejects(
    item.acknowledge(async () => {
      throw new Error('transaction failed');
    }),
    /transaction failed/
  );
  let release;
  const commit = item.acknowledge(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  await assert.rejects(
    item.acknowledge(async () => {}),
    { code: 'account_change_checkpoint_commit_in_progress' }
  );
  release();
  await commit;
  await assert.rejects(
    item.acknowledge(async () => {}),
    { code: 'account_change_checkpoint_closed' }
  );
  assert.equal((await stream.next()).done, true);
});

test('bootstrap acquires C0 before snapshot and drains intervening pages before installation', async () => {
  const events = [],
    requests = [];
  const client = reader([success(page('c0')), success(page('c1', [change()], true)), success(page('c2'))], requests);
  for await (const item of streamAccountChanges(client, {
    account,
    bootstrap: async context => {
      assert.equal(requests[0].starting_position, 'latest');
      assert.equal(requests.length, 1);
      assert.equal(context.reason, 'initial');
      events.push('snapshot');
    },
  })) {
    events.push(...item.changes.map(() => 'repair'));
    await item.acknowledge(async cursor => events.push(cursor.value));
  }
  assert.deepEqual(events, ['snapshot', 'repair', 'c1', 'c2']);
  assert.deepEqual(
    requests.map(r => r.cursor),
    [undefined, 'c0', 'c1']
  );
});

test('CURSOR_EXPIRED reboots latest then snapshot then drain; unrelated errors never reboot', async () => {
  const requests = [],
    events = [];
  const failure = expired();
  const client = reader([failure, success(page('fresh')), success(page('tail'))], requests);
  for await (const item of streamAccountChanges(client, {
    account,
    cursor: restore('expired'),
    bootstrap: async context => {
      assert.equal(context.reason, 'cursor_expired');
      assert.ok(context.error instanceof AccountChangeCursorExpiredError);
      assert.equal(context.error.result, failure);
      events.push('snapshot');
    },
  }))
    await item.acknowledge(async cursor => events.push(cursor.value));
  assert.deepEqual(
    requests.map(r => r.cursor ?? r.starting_position),
    ['expired', 'latest', 'fresh']
  );
  assert.deepEqual(events, ['snapshot', 'tail']);
  await assert.rejects(
    streamAccountChanges(reader([failure]), { account, cursor: restore('expired') }).next(),
    AccountChangeCursorExpiredError
  );
  await assert.rejects(
    streamAccountChanges(reader([{ ...failure, adcpError: { code: 'INVALID_REQUEST' } }]), {
      account,
      cursor: restore('expired'),
      bootstrap: async () => assert.fail('must not reboot'),
    }).next(),
    { code: 'account_change_read_failed' }
  );
});

test('snapshot failure and malformed pages expose no durable checkpoint', async () => {
  await assert.rejects(
    streamAccountChanges(reader([success(page('c0'))]), {
      account,
      bootstrap: async () => {
        throw new Error('snapshot failed');
      },
    }).next(),
    /snapshot failed/
  );
  for (const data of [
    { ...page('c1'), cursor: '' },
    page('c0', [change()], true),
    page('c1', [change({ resource: { type: 'creative', account_id: 'other', resource_id: 'cr_8421' } })]),
    page('c1', [change({ resource: { type: 'media_buy', account_id: account.account_id, resource_id: 'mb_1' } })]),
  ])
    await assert.rejects(
      streamAccountChanges(reader([success(data)]), {
        account,
        cursor: restore('c0'),
        resourceTypes: ['creative'],
      }).next(),
      { code: 'account_change_page_invalid' }
    );
  await assert.rejects(
    streamAccountChanges(reader([]), { account, cursor: parse(webhook(), identity).throughCursor }).next(),
    { code: 'account_change_page_invalid' }
  );
});

test('registration merges subscriber identity without dropping sibling subscribers or event selections', () => {
  const existing = [
    { subscriber_id: 'audit', url: 'https://audit.example/hooks', event_types: ['creative.purged'], active: false },
    { subscriber_id: 'buyer-primary', url: 'https://buyer.example/old', event_types: ['creative.status_changed'] },
  ];
  const original = structuredClone(existing);
  const request = buildAccountChangeSubscriptionRequest({
    account,
    currentConfigs: existing,
    subscriber: { subscriber_id: 'buyer-primary', url: 'https://buyer.example/hooks' },
  });
  assert.deepEqual(existing, original);
  assert.deepEqual(request.accounts[0].notification_configs[0], existing[0]);
  assert.deepEqual(request.accounts[0].notification_configs[1].event_types, [
    'creative.status_changed',
    'account.change_recorded',
  ]);
  assert.deepEqual(Object.keys(request), ['accounts']);
  assert.deepEqual(Object.keys(request.accounts[0]), ['account', 'notification_configs']);
  const again = buildAccountChangeSubscriptionRequest({
    account,
    currentConfigs: request.accounts[0].notification_configs,
    subscriber: { subscriber_id: 'buyer-primary', url: 'https://buyer.example/hooks' },
  });
  assert.deepEqual(again, request);
  assert.throws(
    () =>
      buildAccountChangeSubscriptionRequest({
        account,
        currentConfigs: [existing[0], existing[0]],
        subscriber: existing[1],
      }),
    { code: 'account_change_subscription_invalid' }
  );
  assert.throws(() => buildAccountChangeSubscriptionRequest({ account, subscriber: existing[1] }), {
    code: 'account_change_subscription_invalid',
  });
});

test('normalized capabilities retain the existing change-feed declaration without inventing support', () => {
  const { parseCapabilitiesResponse } = packageRoot
    ? require(path.join(packageRoot, 'dist/lib/utils/capabilities.js'))
    : require('../../dist/lib/utils/capabilities.js');
  const feed = {
    supported: true,
    read_task: 'list_account_changes',
    registration_task: 'sync_accounts',
    event_type: 'account.change_recorded',
    retention_days: 90,
    resource_types: ['creative', 'vendor.future'],
  };
  const caps = parseCapabilitiesResponse({ account: { change_feed: feed } });
  assert.deepEqual(caps.account.changeFeed, feed);
  feed.resource_types.push('changed');
  assert.deepEqual(caps.account.changeFeed.resource_types, ['creative', 'vendor.future']);
  assert.equal(parseCapabilitiesResponse({ account: {} }).account.changeFeed, undefined);
  assert.deepEqual(parseCapabilitiesResponse({ account: { change_feed: { supported: false } } }).account.changeFeed, {
    supported: false,
  });
});
