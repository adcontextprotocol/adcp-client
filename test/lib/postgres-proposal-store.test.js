/** PostgreSQL integration tests. Set DATABASE_URL to run. */

const { before, after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const TABLE = `adcp_test_proposal_${process.pid}`;
const NS = 'test:proposal-store';

describe('PostgresProposalStore', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let pool;
  let api;

  before(async () => {
    api = require('../../dist/lib/server/index.js');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(api.getProposalStoreMigration({ tableName: TABLE }));
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM "${TABLE}" WHERE deployment_namespace LIKE 'test:proposal-store%'`);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      await pool.end();
    }
  });

  function store(namespace = NS, options = {}) {
    return api.createPostgresProposalStore({ db: pool, namespace, tableName: TABLE, ...options });
  }

  async function draft(target, proposalId, accountId) {
    await target.putDraft({
      proposalId,
      accountId,
      recipes: new Map([['product-1', { recipe_kind: 'test', placement: 'hero' }]]),
      proposalPayload: { proposal_id: proposalId },
    });
  }

  it('survives restart and preserves exact proposal/recipe data', async () => {
    const first = store();
    await first.putDraft({
      proposalId: 'proposal-restart',
      accountId: 'acct-a',
      recipes: new Map([
        [
          'product-1',
          {
            recipe_kind: 'test',
            placement: 'hero',
            capability_overlap: {
              pricingModels: new Set(['cpm']),
              targetingDimensions: new Set(),
            },
          },
        ],
      ]),
      proposalPayload: { proposal_id: 'proposal-restart' },
    });
    const expiresAt = new Date(Date.now() + 60_000);
    await first.commit('proposal-restart', {
      expectedAccountId: 'acct-a',
      expiresAt,
      proposalPayload: { proposal_id: 'proposal-restart', locked: true },
    });

    const restarted = store();
    await restarted.probe();
    const record = await restarted.get('proposal-restart', { expectedAccountId: 'acct-a' });
    assert.strictEqual(record.state, 'committed');
    assert.strictEqual(record.recipes.get('product-1').placement, 'hero');
    assert.deepStrictEqual([...record.recipes.get('product-1').capability_overlap.pricingModels], ['cpm']);
    assert.deepStrictEqual([...record.recipes.get('product-1').capability_overlap.targetingDimensions], []);
    assert.deepStrictEqual(record.proposalPayload, { locked: true, proposal_id: 'proposal-restart' });
  });

  it('allows exactly one concurrent reservation and supports rollback/retry', async () => {
    const target = store();
    await draft(target, 'proposal-cas', 'acct-a');
    await target.commit('proposal-cas', {
      expectedAccountId: 'acct-a',
      expiresAt: new Date(Date.now() + 60_000),
      proposalPayload: { proposal_id: 'proposal-cas' },
    });

    const outcomes = await Promise.allSettled([
      target.tryReserveConsumption('proposal-cas', { expectedAccountId: 'acct-a' }),
      target.tryReserveConsumption('proposal-cas', { expectedAccountId: 'acct-a' }),
    ]);
    assert.strictEqual(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.strictEqual(rejected.reason.code, 'PROPOSAL_NOT_COMMITTED');

    await target.releaseConsumption('proposal-cas', { expectedAccountId: 'acct-a' });
    await target.tryReserveConsumption('proposal-cas', { expectedAccountId: 'acct-a' });
    await target.finalizeConsumption('proposal-cas', { expectedAccountId: 'acct-a', mediaBuyId: 'buy-1' });
    await target.finalizeConsumption('proposal-cas', { expectedAccountId: 'acct-a', mediaBuyId: 'buy-1' });
    assert.strictEqual(
      (await target.getByMediaBuyId('buy-1', { expectedAccountId: 'acct-a' })).proposalId,
      'proposal-cas'
    );

    await draft(target, 'proposal-conflict', 'acct-a');
    await target.commit('proposal-conflict', {
      expectedAccountId: 'acct-a',
      expiresAt: new Date(Date.now() + 60_000),
      proposalPayload: { proposal_id: 'proposal-conflict' },
    });
    await target.tryReserveConsumption('proposal-conflict', { expectedAccountId: 'acct-a' });
    await assert.rejects(
      () =>
        target.finalizeConsumption('proposal-conflict', {
          expectedAccountId: 'acct-a',
          mediaBuyId: 'buy-1',
        }),
      error => error.code === 'INTERNAL_ERROR' && /already bound/.test(error.message)
    );
  });

  it('isolates duplicate public proposal and media-buy ids by namespace/account', async () => {
    const first = store(`${NS}:one`);
    const second = store(`${NS}:two`);
    await Promise.all([
      draft(first, 'same-public-id', 'acct-a'),
      draft(first, 'same-public-id', 'acct-b'),
      draft(second, 'same-public-id', 'acct-a'),
    ]);
    assert.strictEqual((await first.get('same-public-id', { expectedAccountId: 'acct-a' })).accountId, 'acct-a');
    assert.strictEqual((await first.get('same-public-id', { expectedAccountId: 'acct-b' })).accountId, 'acct-b');
    assert.strictEqual(await first.get('same-public-id', { expectedAccountId: 'acct-c' }), null);
    assert.strictEqual((await second.get('same-public-id', { expectedAccountId: 'acct-a' })).accountId, 'acct-a');
    await assert.rejects(
      () => first.commit('same-public-id', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} }),
      /multiple tenant scopes/
    );
  });

  it('keeps legacy unscoped commit/discard compatible when the proposal id is unambiguous', async () => {
    const target = store();
    await draft(target, 'legacy-unscoped', 'acct-a');
    await target.commit('legacy-unscoped', {
      expiresAt: new Date(Date.now() + 60_000),
      proposalPayload: { proposal_id: 'legacy-unscoped' },
    });
    assert.strictEqual((await target.get('legacy-unscoped', { expectedAccountId: 'acct-a' })).state, 'committed');
    await target.discard('legacy-unscoped');
    assert.strictEqual(await target.get('legacy-unscoped', { expectedAccountId: 'acct-a' }), null);
  });

  it('uses bounded database-time cleanup and rejects unsafe payloads', async () => {
    const target = store(NS, { draftTtlSeconds: 1, committedGraceSeconds: 1, maxPayloadBytes: 256 });
    await draft(target, 'expired-draft', 'acct-a');
    await pool.query(`UPDATE "${TABLE}" SET created_at=NOW()-INTERVAL '10 seconds' WHERE deployment_namespace=$1`, [
      NS,
    ]);
    assert.strictEqual(await target.cleanupExpired(1), 1);
    assert.strictEqual(await target.get('expired-draft', { expectedAccountId: 'acct-a' }), null);

    await draft(target, 'active-consumption', 'acct-a');
    await target.commit('active-consumption', {
      expectedAccountId: 'acct-a',
      expiresAt: new Date(Date.now() - 10_000),
      proposalPayload: { proposal_id: 'active-consumption' },
    });
    await pool.query(`UPDATE "${TABLE}" SET state='consuming' WHERE proposal_id='active-consumption'`);
    assert.strictEqual(await target.cleanupExpired(10), 0, 'cleanup must never delete an in-flight consumption fence');
    assert.strictEqual((await target.get('active-consumption', { expectedAccountId: 'acct-a' })).state, 'consuming');

    await assert.rejects(
      () =>
        target.putDraft({
          proposalId: 'unsafe',
          accountId: 'acct-a',
          recipes: new Map(),
          proposalPayload: { access_token: 'must-not-persist' },
        }),
      /credential material/
    );
    await assert.rejects(
      () =>
        target.putDraft({
          proposalId: 'unsafe-metadata',
          accountId: 'acct-a',
          recipes: new Map(),
          proposalPayload: { ctx_metadata: { accessToken: 'must-not-persist' } },
        }),
      /server-only metadata/
    );
    for (const credentialKey of [
      'apikey',
      'APIKey',
      'x-api-key',
      'credentials',
      'access.token',
      'access/token',
      'access token',
    ]) {
      await assert.rejects(
        () =>
          target.putDraft({
            proposalId: `unsafe-${credentialKey}`,
            accountId: 'acct-a',
            recipes: new Map(),
            proposalPayload: { [credentialKey]: 'must-not-persist' },
          }),
        /credential material/
      );
    }
    await target.putDraft({
      proposalId: 'safe-key-names',
      accountId: 'acct-a',
      recipes: new Map([
        [
          'product-a',
          { recipe_kind: 'test', credential_id: 'ref-1', token_occurrence: 2, headers: [['content-type', 'json']] },
        ],
      ]),
      proposalPayload: { credential_id: 'ref-1', token_occurrence: 2, headers: [['content-type', 'json']] },
    });
    await assert.rejects(
      () =>
        target.putDraft({
          proposalId: 'unsafe-header-tuple',
          accountId: 'acct-a',
          recipes: new Map([
            ['product-a', { recipe_kind: 'test', headers: [['authorization', 'Bearer must-not-persist']] }],
          ]),
          proposalPayload: {},
        }),
      /credential-shaped tuple key/
    );
    await assert.rejects(
      () =>
        target.putDraft({
          proposalId: 'oversized',
          accountId: 'acct-a',
          recipes: new Map(),
          proposalPayload: { text: 'x'.repeat(300) },
        }),
      /exceeds 256/
    );
    await assert.rejects(
      () =>
        target.commit('missing', {
          expectedAccountId: 'acct-a',
          expiresAt: new Date('invalid'),
          proposalPayload: {},
        }),
      /valid Date/
    );
  });

  it('atomically refuses to reserve a proposal after database expiry', async () => {
    const target = store();
    await draft(target, 'expired-before-reserve', 'acct-a');
    await target.commit('expired-before-reserve', {
      expectedAccountId: 'acct-a',
      expiresAt: new Date(Date.now() + 60_000),
      proposalPayload: { proposal_id: 'expired-before-reserve' },
    });
    await pool.query(`UPDATE "${TABLE}" SET expires_at=NOW()-INTERVAL '1 second' WHERE proposal_id=$1`, [
      'expired-before-reserve',
    ]);
    await assert.rejects(
      () => target.tryReserveConsumption('expired-before-reserve', { expectedAccountId: 'acct-a' }),
      error => error.code === 'PROPOSAL_NOT_COMMITTED'
    );
    assert.strictEqual(
      (await target.get('expired-before-reserve', { expectedAccountId: 'acct-a' })).state,
      'committed'
    );
  });

  it('atomically honors the framework expiry grace cutoff', async () => {
    const target = store();
    await draft(target, 'expiry-grace', 'acct-a');
    await target.commit('expiry-grace', {
      expectedAccountId: 'acct-a',
      expiresAt: new Date(Date.now() - 1_000),
      proposalPayload: { proposal_id: 'expiry-grace' },
    });
    const reserved = await target.tryReserveConsumption('expiry-grace', {
      expectedAccountId: 'acct-a',
      expiresAtCutoff: new Date(Date.now() - 5_000),
    });
    assert.strictEqual(reserved.state, 'consuming');
  });
});
