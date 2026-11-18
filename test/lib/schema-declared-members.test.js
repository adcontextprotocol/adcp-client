// Declared-member projection: where AdCP 3.3.0-beta.6 opened schemas (adcp#8866)
// that the SDK relied on to keep undeclared data out.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { projectToDeclaredMembers } = require('../../dist/lib/adapters/version/schema-projection.js');
const { undeclaredReportingMaterializationMembers } = require('../../dist/lib/reporting/ledger/index.js');
const { exceedsJsonDepth } = require('../../dist/lib/utils/json-depth.js');

test('drops undeclared members at the root and inside declared objects', () => {
  const { value, dropped } = projectToDeclaredMembers('core/account-ref.json', {
    brand: { domain: 'brand.example', internal_note: 'x' },
    operator: 'operator.example',
    db_row_id: 7,
  });
  assert.deepEqual(value, { brand: { domain: 'brand.example' }, operator: 'operator.example' });
  assert.deepEqual(
    dropped.map(drop => drop.path),
    ['brand.internal_note', 'db_row_id']
  );
});

test('keeps the contents of declared free-form maps such as ext', () => {
  const payload = {
    idempotency_key: 'proposal-created-0001-key',
    notification_id: 'n-1',
    notification_type: 'proposal.created',
    fired_at: '2026-11-13T00:00:00Z',
    subscriber_id: 'buyer',
    account_id: 'account-1',
    proposal_id: 'proposal-1',
    opportunity_id: 'opportunity-1',
    later_reason: 'refreshed',
    expires_at: '2026-12-01T00:00:00Z',
    ext: { vendor: { anything: [1, { nested: true }] } },
    seller_prose: 'Buy now',
  };
  const { value, dropped } = projectToDeclaredMembers('core/proposal-created-webhook.json', payload);
  const { seller_prose: _, ...expected } = payload;
  assert.deepEqual(value, expected);
  assert.deepEqual(dropped, [{ path: 'seller_prose', kind: 'field' }]);
});

test('returns the same reference when nothing is undeclared', () => {
  const ref = { account_id: 'account-1' };
  const result = projectToDeclaredMembers('core/account-ref.json', ref);
  assert.equal(result.value, ref);
  assert.deepEqual(result.dropped, []);
});

test('fails closed on an unavailable schema and drops a deep undeclared chain at its first level', () => {
  assert.throws(() => projectToDeclaredMembers('core/no-such-schema.json', {}), /Schema unavailable/);
  const deep = { account_id: 'account-1' };
  let cursor = deep;
  for (let depth = 0; depth < 200_000; depth++) cursor = cursor.retained = {};
  const { value, dropped } = projectToDeclaredMembers('core/account-ref.json', deep);
  assert.deepEqual(value, { account_id: 'account-1' });
  assert.deepEqual(dropped, [{ path: 'retained', kind: 'field' }]);
});

test('reports undeclared reporting materialization evidence members by path', () => {
  assert.deepEqual(undeclaredReportingMaterializationMembers({ resource: { kind: 'manifest' } }), []);
  assert.deepEqual(
    undeclaredReportingMaterializationMembers({
      resource: { kind: 'manifest', signed_url: 'https://example.invalid/?sig=1' },
      adapter_debug: true,
    }),
    ['resource.signed_url', 'adapter_debug']
  );
});

test('exceedsJsonDepth is iterative, sees through shallow aliases, and treats cycles as unbounded', () => {
  const deep = {};
  let cursor = deep;
  for (let depth = 0; depth < 200_000; depth++) cursor = cursor.a = {};
  assert.equal(exceedsJsonDepth(deep), true);
  assert.equal(exceedsJsonDepth({ a: [{ b: 1 }] }), false);

  // A long chain whose nodes are also reachable through shallow aliases that
  // the walk visits first must still count at the chain's full depth.
  const chain = [];
  const head = {};
  let node = head;
  for (let depth = 0; depth < 1_000; depth++) {
    chain.push(node);
    node = node.next = {};
  }
  assert.equal(exceedsJsonDepth({ chain: head, aliases: chain }), true);
  const shared = { leaf: 1 };
  assert.equal(exceedsJsonDepth({ a: shared, b: [shared, { c: shared }] }), false);

  const cyclic = { a: { b: {} } };
  cyclic.a.b.back = cyclic;
  assert.equal(exceedsJsonDepth(cyclic), true);
});
