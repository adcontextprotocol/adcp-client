process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');

const {
  applyTaskSettlementIntent,
  createWebhookDeliveryRecovery,
  memoryWebhookDeliveryRecoveryBackend,
  createInMemoryTaskRegistry,
  createPostgresWebhookRuntime,
  toWebhookRecoveryDisposition,
} = require('../dist/lib/server');

describe('opinionated production workflows', () => {
  it('applies and exactly verifies polling task settlement intents', async () => {
    const registry = createInMemoryTaskRegistry();
    const taskRef = await registry.create({
      tool: 'buy_products',
      accountId: 'account-1',
      ownerScope: 'buyer-1',
    });
    const intent = {
      taskRef,
      action: 'complete',
      result: { media_buy_id: 'media-buy-1', revision: 1 },
    };

    assert.equal(await applyTaskSettlementIntent(intent, { registry }), 'settled');
    assert.equal(await applyTaskSettlementIntent(intent, { registry }), 'settled');
    await assert.rejects(
      applyTaskSettlementIntent({ ...intent, result: { media_buy_id: 'other', revision: 1 } }, { registry }),
      /conflicting settlement artifact/
    );
  });

  it('accepts only applied or exactly compatible push settlements', async () => {
    const taskRef = { taskId: 'task-1', accountId: 'account-1', ownerScope: 'buyer-1', registryId: 'registry-1' };
    const intent = { taskRef, action: 'complete', result: { media_buy_id: 'media-buy-1' } };
    const push = { url: 'https://buyer.example/webhook', operationId: 'operation-1' };

    for (const outcome of [
      { outcome: 'applied', delivery: 'durably_bound' },
      {
        outcome: 'already_terminal',
        status: 'completed',
        compatibility: 'compatible',
        delivery: 'recoverable',
      },
    ]) {
      const coordinator = { settle: async () => outcome };
      assert.equal(await applyTaskSettlementIntent(intent, { coordinator, push }), 'settled');
    }

    for (const outcome of [
      {
        outcome: 'already_terminal',
        status: 'completed',
        compatibility: 'conflicting',
        delivery: 'not_applicable',
      },
      { outcome: 'not_found_in_scope', delivery: 'not_applicable' },
    ]) {
      const coordinator = { settle: async () => outcome };
      await assert.rejects(applyTaskSettlementIntent(intent, { coordinator, push }), /compatibility conflict/);
    }
  });

  it('normalizes every webhook emitter outcome for recovery', () => {
    const base = { delivery_id: 'delivery-1', idempotency_key: 'idempotency-key-1', attempts: 1, errors: [] };
    assert.deepEqual(toWebhookRecoveryDisposition({ ...base, delivered: true }, 500), {
      disposition: 'delivered',
    });
    assert.deepEqual(toWebhookRecoveryDisposition({ ...base, delivered: false, terminal: true }, 500), {
      disposition: 'terminal',
    });
    assert.deepEqual(toWebhookRecoveryDisposition({ ...base, delivered: false }, 500), {
      disposition: 'retry',
      retryAfterMs: 500,
    });
  });

  it('assembles the PostgreSQL webhook runtime, migrations, probes and recovery mapping', async () => {
    const queries = [];
    const db = {
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
    };
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });
    const runtime = createPostgresWebhookRuntime({
      db,
      publisherScope: 'publisher-test',
      tenantScope: 'tenant-test',
      signerKey: {
        keyid: 'webhook-test-key',
        alg: 'ed25519',
        privateKey: { ...privateJwk, kid: 'webhook-test-key', alg: 'ed25519' },
      },
    });

    assert.equal(typeof runtime.emitter.emit, 'function');
    assert.equal(runtime.serverConfig.publisherScope, 'publisher-test');
    assert.equal(runtime.serverConfig.tenantScope, 'tenant-test');
    assert.equal(runtime.serverConfig.deliveryStore.durability, 'durable');
    assert.equal(runtime.serverConfig.deliveryRecovery.durability, 'durable');
    assert.equal(runtime.migrations.all.length, 2);
    assert.match(runtime.migrations.deliveries, /CREATE TABLE IF NOT EXISTS/);
    assert.match(runtime.migrations.outbox, /CREATE TABLE IF NOT EXISTS/);

    await runtime.probe();
    assert.equal(queries.length, 2);
    assert.deepEqual(await runtime.recoverOnce({ ownerToken: 'worker-test' }), {
      claimed: 0,
      settled: 0,
      released: 0,
    });
    const claim = queries.at(-1);
    assert.match(claim.text, /publisher_scope = \$4/);
    assert.match(claim.text, /tenant_scope = \$5/);
    assert.deepEqual(claim.values, ['worker-test', 30000, 1, 'publisher-test', 'tenant-test']);
  });

  it('protects a live task token before the PostgreSQL outbox checkpoint', async () => {
    const vault = new Map();
    const authenticationAdapter = {
      async protect(authentication) {
        const ref = `vault-${vault.size + 1}`;
        vault.set(ref, authentication);
        return { protectedValue: { ref }, fingerprint: ref.padEnd(16, '0') };
      },
      async resolve(protectedValue) {
        return vault.get(protectedValue.ref);
      },
    };
    let storedSnapshot;
    let deliveredBody;
    const db = {
      async query(text, values) {
        if (text.includes('INSERT INTO "adcp_webhook_outbox"')) {
          storedSnapshot = JSON.parse(values[3]);
          return {
            rows: [
              {
                snapshot: storedSnapshot,
                snapshot_fingerprint: values[4],
                storage_fingerprint: values[5],
                state: 'pending',
                attempt_count: 1,
                inserted: true,
                next_attempt_at_ms: Date.now(),
                lease_owner: values[6],
                lease_claim_id: values[8],
                lease_version: 1,
                lease_expires_at_ms: Date.now() + values[7],
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes('INSERT INTO "adcp_webhook_deliveries"')) {
          return {
            rows: [
              {
                status: 'bound',
                idempotency_key: values[3],
                payload_fingerprint: values[4],
                first_attempt_at_ms: Date.now(),
                retain_until_ms: Date.now() + 86_400_000,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes('SET lease_expires_at')) {
          return { rows: [{ lease_expires_at_ms: Date.now() + 30_000 }], rowCount: 1 };
        }
        if (text.includes("SET state = 'settled'")) return { rows: [{ delivery_id: values[2] }], rowCount: 1 };
        throw new Error(`Unexpected query: ${text}`);
      },
    };
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });
    const runtime = createPostgresWebhookRuntime({
      db,
      publisherScope: 'publisher-live',
      tenantScope: 'tenant-live',
      authenticationAdapter,
      signerKey: {
        keyid: 'live-key',
        alg: 'ed25519',
        privateKey: {
          ...privateJwk,
          kid: 'live-key',
          alg: 'EdDSA',
          key_ops: ['sign'],
          adcp_use: 'request-signing',
        },
      },
      fetch: async (_url, init) => {
        deliveredBody = JSON.parse(init.body);
        return { status: 204, headers: { get: () => undefined } };
      },
    });

    const result = await runtime.emitter.emit({
      url: 'https://buyer.invalid/webhook',
      delivery_id: 'live-token-delivery',
      payload: { task_id: 'task-live', token: 'cleartext-validation-token' },
    });
    assert.equal(result.delivered, true, result.errors.join('; '));
    assert.equal(storedSnapshot.payload.token, undefined);
    assert.equal(storedSnapshot.payloadToken.kind, 'protected');
    assert.equal(JSON.stringify(storedSnapshot).includes('cleartext-validation-token'), false);
    assert.equal(deliveredBody.token, 'cleartext-validation-token');
  });

  it('recovers publisher-scoped PostgreSQL leases across tenants and settles every emitter outcome', async () => {
    const vault = new Map();
    const authenticationAdapter = {
      async protect(authentication) {
        const ref = `secret-${vault.size + 1}`;
        vault.set(ref, authentication);
        return { protectedValue: { ref }, fingerprint: ref.padEnd(16, '0') };
      },
      async resolve(protectedValue) {
        return vault.get(protectedValue.ref);
      },
    };
    const preparer = createWebhookDeliveryRecovery({
      backend: { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' },
      authenticationAdapter,
      protectPayloadToken: true,
    });
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });

    for (const scenario of [
      { status: 204, expected: { claimed: 1, settled: 1, released: 0 }, disposition: 'delivered' },
      { status: 400, expected: { claimed: 1, settled: 1, released: 0 }, disposition: 'terminal' },
      { status: 503, expected: { claimed: 1, settled: 0, released: 1 }, disposition: 'retry' },
    ]) {
      const deliveryId = `recovered-${scenario.status}`;
      const key = { publisherScope: 'publisher-test', tenantScope: `tenant-${scenario.status}`, deliveryId };
      const prepared = await preparer.prepare(
        key,
        {
          url: 'https://buyer.invalid/webhook',
          payload: { task_id: deliveryId, token: `validation-${scenario.status}` },
          authentication: null,
          retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        },
        { protectPayloadToken: true }
      );
      const queries = [];
      let claimed = false;
      let body;
      const db = {
        async query(text, values) {
          queries.push({ text, values });
          if (text.includes('WITH candidates AS')) {
            if (claimed) return { rows: [], rowCount: 0 };
            claimed = true;
            return {
              rows: [
                {
                  publisher_scope: key.publisherScope,
                  tenant_scope: key.tenantScope,
                  delivery_id: key.deliveryId,
                  snapshot: prepared.snapshot,
                  snapshot_fingerprint: prepared.snapshotFingerprint,
                  storage_fingerprint: prepared.storageFingerprint,
                  attempt_count: 2,
                  next_attempt_at_ms: Date.now(),
                  lease_owner: 'worker-test',
                  lease_version: 2,
                  lease_expires_at_ms: Date.now() + 30_000,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('SET lease_expires_at')) {
            return { rows: [{ lease_expires_at_ms: Date.now() + 30_000 }], rowCount: 1 };
          }
          if (text.includes('INSERT INTO "adcp_webhook_deliveries"')) {
            return {
              rows: [
                {
                  status: 'bound',
                  idempotency_key: values[3],
                  payload_fingerprint: values[4],
                  first_attempt_at_ms: Date.now(),
                  retain_until_ms: Date.now() + 86_400_000,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes("SET state = 'settled'")) return { rows: [{ delivery_id: deliveryId }], rowCount: 1 };
          if (text.includes('SET lease_owner = NULL')) return { rows: [{ delivery_id: deliveryId }], rowCount: 1 };
          throw new Error(`Unexpected query: ${text}`);
        },
      };
      const runtime = createPostgresWebhookRuntime({
        db,
        publisherScope: key.publisherScope,
        authenticationAdapter,
        recoveryRetryAfterMs: 1_234,
        signerKey: {
          keyid: 'webhook-test-key',
          alg: 'ed25519',
          privateKey: {
            ...privateJwk,
            kid: 'webhook-test-key',
            alg: 'EdDSA',
            key_ops: ['sign'],
            adcp_use: 'request-signing',
          },
        },
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          return { status: scenario.status, headers: { get: () => undefined } };
        },
      });

      const errors = [];
      const recoveryResult = await runtime.recoverOnce({
        ownerToken: 'worker-test',
        onError: error => errors.push(error),
      });
      assert.deepEqual(recoveryResult, scenario.expected, JSON.stringify({ errors, body, queries }));
      assert.equal(body.token, `validation-${scenario.status}`);
      const claim = queries.find(query => query.text.includes('WITH candidates AS'));
      assert.deepEqual(claim.values, ['worker-test', 30000, 1, 'publisher-test']);
      if (scenario.disposition === 'retry') {
        assert.equal(queries.find(query => query.text.includes('SET lease_owner = NULL')).values[5], 1_234);
      } else {
        assert.equal(
          queries.find(query => query.text.includes("SET state = 'settled'")).values[5],
          scenario.disposition
        );
      }
    }
  });
});
