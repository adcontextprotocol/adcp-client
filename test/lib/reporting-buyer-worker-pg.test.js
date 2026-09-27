const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL ?? process.env.DATABASE_URL;

describe('buyer worker signed webhook boundary', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  test('fails closed on registry errors and distinguishes invalid, unknown, and replayed signatures', async () => {
    const { Pool } = require('pg');
    const { signWebhook } = require('../../dist/lib/signing/client.js');
    const {
      StaticJwksResolver,
      InMemoryRevocationStore,
      RequestSignatureError,
    } = require('../../dist/lib/signing/server.js');
    const { startBuyerReporting } = await import('../../examples/reliable-reporting-buyer/worker.mjs');
    const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'webhook-signing-vectors', 'keys.json')));
    const key = fixture.keys.find(entry => entry.kid === 'test-wrong-purpose-2026');
    const { _private_d_for_test_only: privateD, ...publicKey } = key;
    const schema = `adcp_buyer_webhook_${process.pid}`;
    const bootstrap = new Pool({ connectionString: DATABASE_URL });
    let pool;
    let worker;
    try {
      await bootstrap.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
      let lookup = _keyid => undefined;
      let revocationUnavailable = false;
      const revocation = new InMemoryRevocationStore();
      worker = await startBuyerReporting({
        db: pool,
        namespace: 'buyer-worker-test',
        migrate: true,
        runOnStart: false,
        port: 0,
        publicWebhookUrl: 'https://buyer.example.com/prefix/webhooks/reporting',
        listenPath: '/webhooks/reporting',
        jwks: new StaticJwksResolver([publicKey]),
        revocationStore: {
          async isRevoked(keyid) {
            if (revocationUnavailable) {
              throw new RequestSignatureError('request_signature_revocation_stale', 9, 'revocation snapshot is stale');
            }
            return revocation.isRevoked(keyid);
          },
        },
        scopeForVerifiedKey: keyid => lookup(keyid),
        accounts: [
          {
            consumerScope: 'seller.example|buyer-principal-1',
            accountId: 'account-1',
            seller: {},
            request: { account: { account_id: 'account-1' } },
            expectedPeriods: [],
            manifestInspectorOptions: {
              referenceAllowedOrigins: ['https://schemas.seller.example'],
              consumerCommitRef: 'test',
            },
            evaluateAdjustment: () => 'defer',
          },
        ],
      });
      const body = JSON.stringify({
        notification_type: 'reporting.ledger_changed',
        account_id: 'account-1',
        idempotency_key: 'buyer-worker-notification-0001',
      });
      const localUrl = `http://127.0.0.1:${worker.server.address().port}/webhooks/reporting`;
      const signedRequest = () => {
        const signed = signWebhook(
          {
            method: 'POST',
            url: 'https://buyer.example.com/prefix/webhooks/reporting',
            headers: { 'Content-Type': 'application/json' },
            body,
          },
          { keyid: key.kid, alg: 'ed25519', privateKey: { ...publicKey, d: privateD } }
        );
        return { method: 'POST', headers: { 'Content-Type': 'application/json', ...signed.headers }, body };
      };
      lookup = _keyid => {
        throw new Error('registry secret');
      };
      let response = await fetch(localUrl, signedRequest());
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '30');

      lookup = async _keyid => {
        throw new Error('registry secret');
      };
      response = await fetch(localUrl, signedRequest());
      assert.equal(response.status, 503);

      lookup = _keyid => undefined;
      response = await fetch(localUrl, signedRequest());
      assert.equal(response.status, 403);

      lookup = async _keyid => 'other-seller.example|buyer-principal-1';
      const replayed = signedRequest();
      response = await fetch(localUrl, replayed);
      assert.equal(response.status, 204, 'an awaited scope lookup routes only to its matching roster');
      response = await fetch(localUrl, replayed);
      assert.equal(response.status, 409, 'replayed signed body is rejected before routing');

      revocationUnavailable = true;
      response = await fetch(localUrl, signedRequest());
      assert.equal(response.status, 503, 'stale buyer revocation state remains retryable');
      assert.equal(response.headers.get('retry-after'), '30');
      revocationUnavailable = false;

      response = await fetch(localUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 401);
      worker.replaceAccounts([]);
      await worker.stop();
    } finally {
      if (worker) await worker.stop();
      if (pool) await pool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });
});
