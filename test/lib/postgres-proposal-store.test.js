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
    await draft(first, 'proposal-restart', 'acct-a');
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
  });

  it('uses bounded database-time cleanup and rejects unsafe payloads', async () => {
    const target = store(NS, { draftTtlSeconds: 1, committedGraceSeconds: 1, maxPayloadBytes: 256 });
    await draft(target, 'expired-draft', 'acct-a');
    await pool.query(`UPDATE "${TABLE}" SET created_at=NOW()-INTERVAL '10 seconds' WHERE deployment_namespace=$1`, [
      NS,
    ]);
    assert.strictEqual(await target.cleanupExpired(1), 1);
    assert.strictEqual(await target.get('expired-draft', { expectedAccountId: 'acct-a' }), null);

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
  });
});
