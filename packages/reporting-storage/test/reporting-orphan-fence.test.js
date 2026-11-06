/**
 * The orphan collector's fence rules without a database (adcp-client#3292): the decision table, the strict
 * parse of a fence object, and the key helpers.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  decideOrphanFence: decide,
  encodeOrphanFenceRecord: encode,
  isOrphanFenceKey,
  orphanFenceEpochOfKey,
  orphanFenceKey,
  orphanFenceScope,
  parseOrphanFenceRecord: parse,
} = require('../dist/orphan-fence');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NS = 'c'.repeat(64);
const row = (epoch, token, previousToken = null) => ({ epoch, token, previousToken });
const cause = decision => {
  assert.equal(decision.action, 'fenced');
  return decision.refusal.cause;
};

describe('decideOrphanFence', () => {
  test('claims epoch 1 when neither side has a claim, and the next epoch when the bucket matches the record', () => {
    assert.deepEqual(decide(null, null), { action: 'claim', epoch: 1, previousToken: null });
    assert.deepEqual(decide(row(3, B, A), { epoch: 3, token: B }), { action: 'claim', epoch: 4, previousToken: B });
  });

  test('refuses a namespace claimed by a database it has no record of', () => {
    assert.equal(cause(decide(null, { epoch: 1, token: A })), 'claimed_elsewhere');
  });

  test('finishes its own unfinished claim: the object is missing, or one epoch behind with the recorded previous token', () => {
    assert.deepEqual(decide(row(1, A), null), { action: 'complete' });
    assert.deepEqual(decide(row(3, B, A), { epoch: 2, token: A }), { action: 'complete' });
  });

  test('refuses every other state, with the epochs in the refusal', () => {
    assert.equal(cause(decide(row(2, B, A), null)), 'fence_missing');
    assert.equal(cause(decide(row(1, A, B), null)), 'fence_missing');
    assert.equal(cause(decide(row(3, B, A), { epoch: 3, token: A })), 'token_mismatch');
    assert.equal(cause(decide(row(1, A), { epoch: 2, token: B })), 'fence_advanced');
    // Behind its record, but not by one claim of its own.
    assert.equal(cause(decide(row(3, B, A), { epoch: 2, token: B })), 'fence_regressed');
    assert.equal(cause(decide(row(3, B, null), { epoch: 2, token: A })), 'fence_regressed');
    assert.equal(cause(decide(row(5, B, A), { epoch: 2, token: A })), 'fence_regressed');
    const advanced = decide(row(1, A), { epoch: 7, token: B });
    assert.equal(advanced.refusal.fenceEpoch, 7);
    assert.equal(advanced.refusal.recordedEpoch, 1);
    assert.match(advanced.refusal.detail, /takeOverOrphanCollectorFence/);
  });

  test('no input makes it delete when the bucket is ahead of the record', () => {
    for (const ahead of [2, 3, 10, 1_000_000]) {
      assert.equal(decide(row(1, A), { epoch: ahead, token: A }).action, 'fenced');
    }
  });
});

describe('fence objects and keys', () => {
  const record = { epoch: 4, token: A, previousToken: B, claimedAt: '2026-11-02T10:00:00.000Z' };
  const good = () => JSON.parse(Buffer.from(encode(NS, record)).toString('utf8'));
  const parseObject = (value, expected = { namespaceKey: NS, epoch: 4 }) =>
    parse(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), expected);

  test('round-trips, and a first claim carries a null previous token', () => {
    assert.deepEqual(parse(encode(NS, record), { namespaceKey: NS, epoch: 4 }), record);
    const first = { ...record, epoch: 1, previousToken: null };
    assert.deepEqual(parse(encode(NS, first), { namespaceKey: NS, epoch: 1 }), first);
  });

  test('parses strictly: anything that is not exactly a fence of this namespace and epoch is rejected', () => {
    assert.ok(parseObject(good()));
    const mutations = {
      'another namespace': { namespace_key: 'd'.repeat(64) },
      'another epoch': { epoch: 5 },
      'another version': { v: 2 },
      'upper-case token': { token: A.toUpperCase() },
      'token that is not a uuid': { token: 'nope' },
      'previous token of the wrong type': { previous_token: 7 },
      'previous token that is not a uuid': { previous_token: 'x' },
      'an unreadable instant': { claimed_at: 'yesterday' },
      'an extra field': { extra: true },
      'a missing field': { token: undefined },
    };
    for (const [name, change] of Object.entries(mutations)) {
      assert.equal(parseObject({ ...good(), ...change }), undefined, name);
    }
    for (const bytes of ['not json', 'null', '[]', '"text"', '7', '', `${JSON.stringify(good())}${' '.repeat(5000)}`]) {
      assert.equal(parseObject(bytes), undefined, bytes.slice(0, 20));
    }
  });

  test('keys sort by epoch, and only exact epoch names under the fence directory count', () => {
    const owned = `orph/${NS}/`;
    assert.equal(orphanFenceKey(owned, 7), `${owned}_collector-fence/0000000000000007.json`);
    assert.ok(orphanFenceKey(owned, 9) < orphanFenceKey(owned, 10), 'zero padding keeps them in epoch order');
    assert.equal(orphanFenceEpochOfKey(owned, orphanFenceKey(owned, 12)), 12);
    for (const key of [
      `${owned}_collector-fence/000000000000007.json`,
      `${owned}_collector-fence/0000000000000000.json`,
      `${owned}_collector-fence/0000000000000007.jsonl`,
      `${owned}_collector-fence/nested/0000000000000007.json`,
      `${owned}_collector-fence/0000000000000007.json.tmp`,
      `${owned}other/0000000000000007.json`,
      `orph/other/_collector-fence/0000000000000007.json`,
    ]) {
      assert.equal(orphanFenceEpochOfKey(owned, key), undefined, key);
    }
    assert.ok(isOrphanFenceKey(owned, `${owned}_collector-fence/anything`));
    assert.equal(isOrphanFenceKey(owned, `${owned}acct/a.jsonl`), false);
  });

  test('a fence is one physical place: provider, location, prefix and namespace', () => {
    const base = { provider: 's3', location: { bucket: 'b' }, prefix: 'rows', namespaceKey: NS };
    assert.equal(orphanFenceScope(base), orphanFenceScope({ ...base, location: { bucket: 'b' } }));
    assert.match(orphanFenceScope(base), /^[0-9a-f]{64}$/);
    for (const change of [
      { provider: 'gcs' },
      { location: { bucket: 'c' } },
      { prefix: 'other' },
      { namespaceKey: 'd'.repeat(64) },
    ]) {
      assert.notEqual(orphanFenceScope({ ...base, ...change }), orphanFenceScope(base));
    }
  });
});
