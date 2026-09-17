'use strict';

require('tsx/cjs');

const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const {
  migrateDurableBuyer,
  PostgresOperationLedger,
  STORE_NAMES,
} = require('../../examples/durable-buyer-writes/caller.ts');
const { publishOne } = require('../../examples/durable-buyer-writes/worker.ts');

const DATABASE_URL = process.env.DURABLE_BUYER_WRITES_PG_URL || process.env.DATABASE_URL;

describe('durable buyer writes PostgreSQL example', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_durable_buyer_${process.pid}_${randomBytes(4).toString('hex')}`;
  let bootstrap;
  let pool;
  let ledger;

  const session = {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    sellerId: 'seller-a',
    sellerUrl: 'https://seller.example/mcp',
    sellerProtocol: 'mcp',
    sellerAccountId: 'account-a',
    authToken: 'request-local-test-token',
  };
  const request = {
    account: { account_id: session.sellerAccountId },
    feed_version: 'feed-v1',
    purchases: [{ product_id: 'product-a', pricing_option_id: 'price-a' }],
    start_time: 'asap',
    end_time: '2027-01-01T00:00:00Z',
  };
  const failed = message => ({ status: 'failed', errors: [{ code: 'INTERNAL_ERROR', message }] });
  const completed = (mediaBuyStatus, confirmedAt) => ({
    status: 'completed',
    media_buy_id: 'media-buy-a',
    revision: 1,
    accepted_proposal: {
      proposal_id: 'proposal-a',
      proposal_kind: 'new_media_buy',
      proposal_status: 'accepted',
      media_buy_id: 'media-buy-a',
      accepted_at: '2026-09-17T00:00:00Z',
      name: 'Accepted proposal',
      commercial_terms: {
        brand: { domain: 'example.com' },
        purchases: [
          {
            product_id: 'product-a',
            pricing_option_id: 'price-a',
            pricing: {
              pricing_option_id: 'price-a',
              pricing_model: 'cpm',
              currency: 'USD',
              fixed_price: 10,
            },
            start_time: '2026-09-18T00:00:00Z',
            end_time: '2027-01-01T00:00:00Z',
          },
        ],
        start_time: '2026-09-18T00:00:00Z',
        end_time: '2027-01-01T00:00:00Z',
      },
      terms_digest: `sha256:${'A'.repeat(43)}`,
    },
    purchase_bindings: [{ purchase_index: 0, product_id: 'product-a', package_id: 'package-a' }],
    available_actions: [],
    media_buy_status: mediaBuyStatus,
    confirmed_at: confirmedAt,
  });

  before(async () => {
    const { Pool } = require('pg');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await migrateDurableBuyer(pool);
    ledger = new PostgresOperationLedger(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('concurrent duplicates create one winner and conflicting observations cannot replace it', async () => {
    const logicalOperationId = 'operation-identical';
    await ledger.stage(logicalOperationId, 'order-identical', session, request);

    await Promise.all([
      ledger.observe(logicalOperationId, 'failed', failed('seller unavailable'), 'seller-task-a'),
      ledger.observe(logicalOperationId, 'failed', failed('seller unavailable'), 'seller-task-a'),
    ]);

    const stored = await ledger.get(logicalOperationId);
    assert.equal(stored.status, 'failed');
    assert.deepEqual(stored.terminalResult, failed('seller unavailable'));
    const outbox = await pool.query(
      `SELECT terminal_fingerprint, payload FROM ${STORE_NAMES.publications}
       WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
      [STORE_NAMES.deployment, logicalOperationId]
    );
    assert.equal(outbox.rowCount, 1);
    assert.equal(outbox.rows[0].terminal_fingerprint, stored.terminalFingerprint);

    await assert.rejects(
      ledger.observe(logicalOperationId, 'failed', failed('different terminal result'), 'seller-task-a'),
      /Conflicting terminal observation/
    );
    assert.deepEqual((await ledger.get(logicalOperationId)).terminalResult, failed('seller unavailable'));
    await pool.query(
      `UPDATE ${STORE_NAMES.publications} SET published_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
      [STORE_NAMES.deployment, logicalOperationId]
    );
  });

  test('outbox insertion failure rolls back the terminal winner', async () => {
    const logicalOperationId = 'operation-rollback';
    await ledger.stage(logicalOperationId, 'order-rollback', session, request);
    await pool.query(`
      CREATE FUNCTION reject_durable_buyer_publication() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test publication failure'; END $$;
      CREATE TRIGGER reject_durable_buyer_publication
      BEFORE INSERT ON ${STORE_NAMES.publications}
      FOR EACH ROW EXECUTE FUNCTION reject_durable_buyer_publication();
    `);
    try {
      await assert.rejects(
        ledger.observe(logicalOperationId, 'failed', failed('must roll back'), 'seller-task-b'),
        /test publication failure/
      );
    } finally {
      await pool.query(`DROP TRIGGER reject_durable_buyer_publication ON ${STORE_NAMES.publications}`);
      await pool.query('DROP FUNCTION reject_durable_buyer_publication()');
    }

    const stored = await ledger.get(logicalOperationId);
    assert.equal(stored.terminalFingerprint, undefined);
    assert.equal(stored.terminalResult, undefined);
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) FROM ${STORE_NAMES.publications}
             WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
            [STORE_NAMES.deployment, logicalOperationId]
          )
        ).rows[0].count
      ),
      0
    );
  });

  test('mutable readback fields converge on one immutable commitment fingerprint', async () => {
    const logicalOperationId = 'operation-mutable-readback';
    const first = completed('active', '2026-09-17T00:00:00Z');
    await ledger.stage(logicalOperationId, 'order-mutable-readback', session, request);
    await ledger.observe(logicalOperationId, 'completed', first, 'seller-task-mutable');
    await ledger.observe(
      logicalOperationId,
      'completed',
      completed('paused', '2026-09-17T00:01:00Z'),
      'seller-task-mutable'
    );

    const stored = await ledger.get(logicalOperationId);
    assert.deepEqual(stored.terminalResult, first);
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) FROM ${STORE_NAMES.publications}
             WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
            [STORE_NAMES.deployment, logicalOperationId]
          )
        ).rows[0].count
      ),
      1
    );
    await pool.query(
      `UPDATE ${STORE_NAMES.publications} SET published_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
      [STORE_NAMES.deployment, logicalOperationId]
    );
  });

  test('an expired publication lease is reclaimed without duplicate publication', async () => {
    const logicalOperationId = 'operation-publication-recovery';
    await ledger.stage(logicalOperationId, 'order-publication-recovery', session, request);
    await ledger.observe(logicalOperationId, 'failed', failed('publish once'), 'seller-task-c');
    await pool.query(
      `UPDATE ${STORE_NAMES.publications}
       SET claim_token = 'dead-worker', claim_expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
      [STORE_NAMES.deployment, logicalOperationId]
    );

    const publications = [];
    const publishIdempotently = async publication => publications.push(publication);
    assert.equal(await publishOne({ pool }, publishIdempotently), true);
    assert.equal(await publishOne({ pool }, publishIdempotently), false);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].logicalOperationId, logicalOperationId);
  });
});
