const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const {
  memoryWebhookDeliveryStore,
  memoryWebhookDeliveryRecoveryBackend,
  createWebhookDeliveryRecovery,
  pollWebhookDeliveryRecovery,
  createWebhookEmitter,
  pgWebhookDeliveryStore,
  pgWebhookDeliveryRecoveryBackend,
  redisWebhookDeliveryStore,
  redisWebhookDeliveryRecoveryBackend,
  getWebhookDeliveryMigration,
  getWebhookDeliveryRecoveryMigration,
  WebhookAuthenticationResolutionError,
} = require('../../dist/lib/server/index.js');
const {
  runWebhookDeliveryStoreContract,
  runWebhookRecoveryBackendContract,
} = require('../helpers/webhook-delivery-contract.js');

runWebhookDeliveryStoreContract('memoryWebhookDeliveryStore', async () => memoryWebhookDeliveryStore());
runWebhookRecoveryBackendContract('memoryWebhookDeliveryRecoveryBackend', async () =>
  memoryWebhookDeliveryRecoveryBackend()
);

test('PostgreSQL recovery probe rejects an outbox missing the settlement intent fingerprint column', async () => {
  let probeSql;
  const backend = pgWebhookDeliveryRecoveryBackend({
    async query(sql) {
      probeSql = sql;
      const error = new Error('column intent_fingerprint does not exist');
      error.code = '42703';
      throw error;
    },
  });
  await assert.rejects(() => backend.probe(), /Run getWebhookDeliveryRecoveryMigration/);
  assert.match(probeSql, /intent_fingerprint/);
});

test('memory delivery store permanently retires an expired identity', async () => {
  let now = 1_000;
  const store = memoryWebhookDeliveryStore({ now: () => now });
  const key = { publisherScope: 'p', tenantScope: 't', deliveryId: 'd' };
  const first = await store.claim(
    key,
    { idempotencyKey: 'idempotency.key.0001', payloadFingerprint: 'a'.repeat(64) },
    100
  );
  assert.equal(first.status, 'bound');
  now = 1_101;
  assert.deepEqual(
    await store.claim(key, { idempotencyKey: 'idempotency.key.0002', payloadFingerprint: 'b'.repeat(64) }, 100),
    { status: 'retired' }
  );
  now = 10_000;
  assert.deepEqual(
    await store.claim(key, { idempotencyKey: 'idempotency.key.0003', payloadFingerprint: 'c'.repeat(64) }, 100),
    { status: 'retired' }
  );
});

test('recovery wrapper protects credentials and polling settles only the fenced lease', async () => {
  const memory = memoryWebhookDeliveryRecoveryBackend();
  const backend = { ...memory, durability: 'durable' };
  const protectedValues = [];
  const authenticationContexts = [];
  const recovery = createWebhookDeliveryRecovery({
    backend,
    authenticationAdapter: {
      protect(authentication, context) {
        assert.equal(context.url, 'https://buyer.invalid/hook');
        protectedValues.push(authentication);
        authenticationContexts.push(structuredClone(context));
        return { protectedValue: { secretRef: 'kms://webhook/a' }, fingerprint: 'stable-secret-token' };
      },
      resolve(value, context) {
        assert.equal(context.key.deliveryId, 'delivery-recovery-wrapper');
        authenticationContexts.push(structuredClone(context));
        assert.deepEqual(value, { secretRef: 'kms://webhook/a' });
        return { type: 'bearer', token: 'resolved-only-in-worker' };
      },
    },
  });
  const key = { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'delivery-recovery-wrapper' };
  const liveClaim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'task-1' },
    authentication: { type: 'bearer', token: 'plaintext-input' },
    retries: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 60000, jitter: 0.25 },
  });
  assert.deepEqual(protectedValues, [{ type: 'bearer', token: 'plaintext-input' }]);
  assert.ok(liveClaim, 'checkpoint atomically reserves the live delivery');
  assert.deepEqual(await recovery.claimPending({ ownerToken: 'blocked-worker', limit: 1 }), []);
  assert.equal(await liveClaim.release(0), true);

  const seen = [];
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    ownerToken: 'recovery-worker-a',
    deliver: async lease => {
      seen.push(lease.snapshot.authentication);
      return { disposition: 'delivered' };
    },
  });
  assert.deepEqual(result, { claimed: 1, settled: 1, released: 0 });
  assert.deepEqual(seen, [{ type: 'bearer', token: 'resolved-only-in-worker' }]);
  assert.equal(authenticationContexts[0].purpose, undefined);
  assert.deepEqual(authenticationContexts[1], authenticationContexts[0], 'legacy KMS context remains upgrade-safe');
});

test('recovery requires a secret adapter instead of persisting plaintext credentials', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  await assert.rejects(
    () =>
      recovery.checkpoint(
        { publisherScope: 'p', tenantScope: 't', deliveryId: 'd-secret' },
        {
          url: 'https://buyer.invalid',
          payload: {},
          authentication: { type: 'hmac_sha256', secret: 'must-not-persist' },
          retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        }
      ),
    /requires authenticationAdapter/
  );
});

test('recovery sanitizes secret-adapter resolution failures', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({
    backend,
    authenticationAdapter: {
      protect() {
        return { protectedValue: { ref: 'kms://private/key' }, fingerprint: 'stable-secret-token' };
      },
      resolve() {
        throw new Error('private KMS endpoint and credential details');
      },
    },
  });
  const claim = await recovery.checkpoint(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'resolution-failure' },
    {
      url: 'https://buyer.invalid/hook',
      payload: {},
      authentication: { type: 'bearer', token: 'plaintext-input-1' },
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }
  );
  await claim.release(0);
  await assert.rejects(
    () => recovery.claimPending({ ownerToken: 'resolution-worker', limit: 1 }),
    error => {
      assert.ok(error instanceof WebhookAuthenticationResolutionError);
      assert.equal(error.message, 'Webhook authentication resolution failed');
      assert.doesNotMatch(error.message, /private KMS|credential/);
      assert.match(error.cause.message, /private KMS endpoint/);
      return true;
    }
  );
});

test('recovery protects and restores task payload validation tokens independently of HTTP auth', async () => {
  const memory = memoryWebhookDeliveryRecoveryBackend();
  const backend = { ...memory, durability: 'durable' };
  const protectedPurposes = [];
  const recovery = createWebhookDeliveryRecovery({
    backend,
    authenticationAdapter: {
      protect(authentication, context) {
        protectedPurposes.push(context.purpose);
        return {
          protectedValue: { ref: `kms://${context.purpose}` },
          fingerprint: `fingerprint-${context.purpose}`,
        };
      },
      resolve(_value, context) {
        assert.equal(context.purpose, 'payload_token');
        return { type: 'bearer', token: 'restored-validation-token' };
      },
    },
  });
  const key = { publisherScope: 'p', tenantScope: 't', deliveryId: 'payload-token-delivery' };
  const prepared = await recovery.prepare(
    key,
    {
      url: 'https://buyer.invalid/hook',
      payload: { task_id: 'task-token', token: 'plaintext-validation-token' },
      authentication: null,
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    },
    { protectPayloadToken: true }
  );
  const checkpoint = await backend.checkpoint(
    key,
    prepared.snapshot,
    prepared.snapshotFingerprint,
    prepared.storageFingerprint,
    { ownerToken: 'settlement-preparer', leaseMs: 1000 }
  );
  assert.deepEqual(protectedPurposes, ['payload_token']);
  assert.ok(checkpoint.lease);
  await backend.release(checkpoint.lease, 0);
  const [recovered] = await recovery.claimPending({ ownerToken: 'payload-token-worker', limit: 1 });
  assert.equal(recovered.snapshot.payload.token, 'restored-validation-token');
});

test('generic recovery preserves a non-secret payload.token without requiring an adapter', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const key = { publisherScope: 'p', tenantScope: 't', deliveryId: 'generic-token-field' };
  const claim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid/hook',
    payload: { token: 'ordinary-domain-value' },
    authentication: null,
    retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  });
  assert.ok(claim);
  await claim.release(0);
  const [recovered] = await recovery.claimPending({ ownerToken: 'generic-token-worker', limit: 1 });
  assert.equal(recovered.snapshot.payload.token, 'ordinary-domain-value');
});

test('task recovery mode protects payload.token on live checkpoints', async () => {
  const delegate = memoryWebhookDeliveryRecoveryBackend();
  let persisted;
  const backend = {
    ...delegate,
    durability: 'durable',
    checkpoint(key, snapshot, ...rest) {
      persisted = structuredClone(snapshot);
      return delegate.checkpoint(key, snapshot, ...rest);
    },
  };
  const recovery = createWebhookDeliveryRecovery({
    backend,
    protectPayloadToken: true,
    authenticationAdapter: {
      protect(authentication, context) {
        assert.equal(context.purpose, 'payload_token');
        return { protectedValue: { ref: 'secret://task-token' }, fingerprint: 'task-token-fingerprint' };
      },
      resolve() {
        return { type: 'bearer', token: 'restored-task-token' };
      },
    },
  });
  const key = { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'protected-live-token' };
  const claim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'task-1', token: 'cleartext-task-token' },
    authentication: null,
    retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  });
  assert.ok(claim);
  assert.equal(persisted.payload.token, undefined);
  assert.equal(persisted.payloadToken.kind, 'protected');
  await claim.release(0);
  const [lease] = await recovery.claimPending({ ownerToken: 'recovery-worker', limit: 1 });
  assert.equal(lease.snapshot.payload.token, 'restored-task-token');
});

test('recovery rejects adapters that return cleartext as protected durable state', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({
    backend,
    authenticationAdapter: {
      protect(authentication) {
        return { protectedValue: { token: authentication.token }, fingerprint: 'safe-looking-fingerprint' };
      },
      resolve() {
        throw new Error('not reached');
      },
    },
  });
  await assert.rejects(
    () =>
      recovery.checkpoint(
        { publisherScope: 'p', tenantScope: 't', deliveryId: 'plaintext-adapter' },
        {
          url: 'https://buyer.invalid/hook',
          payload: {},
          authentication: { type: 'bearer', token: 'cleartext-must-not-persist' },
          retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        }
      ),
    /durable state containing cleartext/
  );
});

test('recovery bounds each durable snapshot before backend persistence', async () => {
  const base = memoryWebhookDeliveryRecoveryBackend();
  let checkpoints = 0;
  const backend = {
    ...base,
    durability: 'durable',
    async checkpoint(...args) {
      checkpoints++;
      return base.checkpoint(...args);
    },
  };
  const recovery = createWebhookDeliveryRecovery({ backend, maxSnapshotBytes: 128 });
  await assert.rejects(
    () =>
      recovery.checkpoint(
        { publisherScope: 'p', tenantScope: 't', deliveryId: 'oversized-snapshot' },
        {
          url: 'https://buyer.invalid',
          payload: { result: 'x'.repeat(256) },
          authentication: null,
          retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        }
      ),
    /exceeds maxSnapshotBytes/
  );
  assert.equal(checkpoints, 0);
});

test('polling heartbeats a long-running delivery lease', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend, defaultLeaseMs: 1_000 });
  const key = { publisherScope: 'p', tenantScope: 't', deliveryId: 'heartbeat-delivery' };
  const liveClaim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid',
    payload: { empty: [] },
    authentication: null,
    retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  });
  assert.ok(liveClaim);
  await liveClaim.release(0);
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    leaseMs: 1_000,
    limit: 1,
    deliver: async () => {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      return { disposition: 'delivered' };
    },
  });
  assert.deepEqual(result, { claimed: 1, settled: 1, released: 0 });
});

test('live emitter heartbeats its outbox lease across a slow POST and backend clock skew', async () => {
  const backend = {
    ...memoryWebhookDeliveryRecoveryBackend({ now: () => Date.now() + 5_000 }),
    durability: 'durable',
  };
  const recovery = createWebhookDeliveryRecovery({ backend, defaultLeaseMs: 1_000 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'slow-live-key',
      alg: 'ed25519',
      privateKey: {
        ...privateJwk,
        kid: 'slow-live-key',
        alg: 'EdDSA',
        key_ops: ['sign'],
        adcp_use: 'request-signing',
      },
    },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryRecovery: recovery,
    fetch: async () => {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      return { status: 204, headers: { get: () => undefined } };
    },
  });
  const result = await emitter.emit({
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'slow-live-task' },
    delivery_id: 'slow-live-delivery',
    retries: { maxAttempts: 1 },
  });
  assert.equal(result.delivered, true, result.errors.join('; '));
  assert.deepEqual(await recovery.claimPending({ ownerToken: 'post-live-worker', limit: 1 }), []);
});

test('heartbeat diagnostics do not inflate the delivery attempt count', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  let renewals = 0;
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'attempt-count-key',
      alg: 'ed25519',
      privateKey: {
        ...privateJwk,
        kid: 'attempt-count-key',
        alg: 'EdDSA',
        key_ops: ['sign'],
        adcp_use: 'request-signing',
      },
    },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryRecovery: {
      durability: 'durable',
      checkpoint() {
        return {
          leaseExpiresAtMs: Date.now() + 1_000,
          heartbeatIntervalMs: 250,
          async renew() {
            renewals++;
            return renewals === 1;
          },
          async release() {
            return false;
          },
          async settle() {
            return false;
          },
        };
      },
      async settle() {},
    },
    retries: { maxAttempts: 1 },
    fetch: async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return { status: 503, headers: { get: () => undefined } };
    },
  });
  const result = await emitter.emit({
    url: 'https://buyer.invalid/hook',
    payload: {},
    delivery_id: 'attempt-count-delivery',
  });
  assert.equal(result.attempts, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[1], /recovery lease was lost/);
});

test('live heartbeat preserves a backend renewal failure as a sanitized error cause', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const backendError = new Error('redis shard temporarily unavailable');
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'heartbeat-cause-key',
      alg: 'ed25519',
      privateKey: {
        ...privateJwk,
        kid: 'heartbeat-cause-key',
        alg: 'EdDSA',
        key_ops: ['sign'],
        adcp_use: 'request-signing',
      },
    },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryRecovery: {
      durability: 'durable',
      checkpoint() {
        return {
          leaseExpiresAtMs: Date.now() + 1_000,
          async renew() {
            throw backendError;
          },
          async release() {
            return false;
          },
          async settle() {
            return false;
          },
        };
      },
      async settle() {},
    },
    fetch: async () => {
      throw new Error('delivery must not start after renewal fails');
    },
  });
  await assert.rejects(
    () => emitter.emit({ url: 'https://buyer.invalid/hook', payload: {}, delivery_id: 'heartbeat-cause' }),
    error => {
      assert.equal(error.message, 'Webhook delivery recovery lease was lost during backend renewal');
      assert.equal(error.cause, backendError);
      return true;
    }
  );
});

test('polling reports renewal failures without an unhandled rejection or stale settlement', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const baseRecovery = createWebhookDeliveryRecovery({ backend, defaultLeaseMs: 1_000 });
  const liveClaim = await baseRecovery.checkpoint(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'renewal-failure-delivery' },
    {
      url: 'https://buyer.invalid',
      payload: {},
      authentication: null,
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }
  );
  assert.ok(liveClaim);
  await liveClaim.release(0);
  let renewals = 0;
  const recovery = {
    ...baseRecovery,
    async renew(lease, leaseMs) {
      renewals++;
      if (renewals > 1) throw new Error('backend temporarily unavailable');
      return baseRecovery.renew(lease, leaseMs);
    },
  };
  const errors = [];
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    leaseMs: 1_000,
    limit: 1,
    onError: error => errors.push(error),
    deliver: async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return { disposition: 'delivered' };
    },
  });
  assert.deepEqual(result, { claimed: 1, settled: 0, released: 0 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /temporarily unavailable/);
});

test('polling reports fenced lease loss without stale settlement', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const baseRecovery = createWebhookDeliveryRecovery({ backend, defaultLeaseMs: 1_000 });
  const liveClaim = await baseRecovery.checkpoint(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'renewal-loss-delivery' },
    {
      url: 'https://buyer.invalid',
      payload: {},
      authentication: null,
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }
  );
  assert.ok(liveClaim);
  await liveClaim.release(0);
  let renewals = 0;
  const recovery = {
    ...baseRecovery,
    async renew(lease, leaseMs) {
      renewals++;
      if (renewals > 1) return false;
      return baseRecovery.renew(lease, leaseMs);
    },
  };
  const errors = [];
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    leaseMs: 1_000,
    limit: 1,
    onError: error => errors.push(error),
    deliver: async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return { disposition: 'delivered' };
    },
  });
  assert.deepEqual(result, { claimed: 1, settled: 0, released: 0 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /lease ownership was lost/);
});

test('one recovery poll attempts a thrown delivery only once', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const liveClaim = await recovery.checkpoint(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'throwing-delivery' },
    {
      url: 'https://buyer.invalid',
      payload: {},
      authentication: null,
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }
  );
  assert.ok(liveClaim);
  await liveClaim.release(0);
  let calls = 0;
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    limit: 5,
    deliver: async () => {
      calls++;
      throw new Error('retry me later');
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { claimed: 1, settled: 0, released: 1 });
});

test('recovery poll rejects malformed callback outcomes and releases them with backoff', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const liveClaim = await recovery.checkpoint(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'malformed-outcome-delivery' },
    {
      url: 'https://buyer.invalid',
      payload: {},
      authentication: null,
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }
  );
  assert.ok(liveClaim);
  await liveClaim.release(0);
  const errors = [];
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    limit: 1,
    onError: error => errors.push(error),
    deliver: async () => ({ delivered: true, errors: [] }),
  });
  assert.deepEqual(result, { claimed: 1, settled: 0, released: 1 });
  assert.match(errors[0].message, /invalid disposition/);
});

test('live emitter reports failed terminal settlement and retry release fences', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const statuses = [400, 503];
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'failed-fence-key',
      alg: 'ed25519',
      privateKey: {
        ...privateJwk,
        kid: 'failed-fence-key',
        alg: 'EdDSA',
        key_ops: ['sign'],
        adcp_use: 'request-signing',
      },
    },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryRecovery: {
      durability: 'durable',
      checkpoint() {
        return {
          leaseExpiresAtMs: Date.now() + 30_000,
          heartbeatIntervalMs: 10_000,
          async renew() {
            return true;
          },
          async release() {
            return false;
          },
          async settle() {
            return false;
          },
        };
      },
      async settle() {},
    },
    retries: { maxAttempts: 1 },
    fetch: async () => ({ status: statuses.shift(), headers: { get: () => undefined } }),
  });
  const terminal = await emitter.emit({
    url: 'https://buyer.invalid/hook',
    payload: {},
    delivery_id: 'failed-terminal-settle',
  });
  assert.match(terminal.errors.at(-1), /could not settle its recovery lease/);
  const retryable = await emitter.emit({
    url: 'https://buyer.invalid/hook',
    payload: {},
    delivery_id: 'failed-retry-release',
  });
  assert.match(retryable.errors.at(-1), /could not release its recovery lease/);
});

test('live emitter terminalizes its checkpoint when delivery binding fails terminally', async () => {
  const deliveryStore = memoryWebhookDeliveryStore();
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const signerKey = {
    keyid: 'live-conflict-key',
    alg: 'ed25519',
    privateKey: {
      ...privateJwk,
      kid: 'live-conflict-key',
      alg: 'EdDSA',
      key_ops: ['sign'],
      adcp_use: 'request-signing',
    },
  };
  const key = { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'live-conflicting-delivery' };
  await deliveryStore.claim(
    key,
    { idempotencyKey: 'live.conflict.binding.0001', payloadFingerprint: 'a'.repeat(64) },
    86_400_000
  );
  const emitter = createWebhookEmitter({
    signerKey,
    publisherScope: key.publisherScope,
    tenantScope: key.tenantScope,
    deliveryStore,
    deliveryRecovery: recovery,
    fetch: async () => {
      throw new Error('conflicting live deliveries must not POST');
    },
  });
  await assert.rejects(
    () =>
      emitter.emit({
        url: 'https://buyer.invalid/hook',
        payload: { task_id: 'changed' },
        delivery_id: key.deliveryId,
      }),
    /already bound to a different canonical payload/
  );
  assert.deepEqual(await recovery.claimPending({ ownerToken: 'after-live-conflict', limit: 1 }), []);
});

test('recovery terminalizes a pending delivery after its binding retires', async () => {
  let now = 1_000;
  const deliveryStore = memoryWebhookDeliveryStore({ now: () => now });
  const backend = { ...memoryWebhookDeliveryRecoveryBackend({ now: () => now }), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend, defaultLeaseMs: 1_000 });
  const key = { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'retired-recovery-delivery' };
  await deliveryStore.claim(
    key,
    { idempotencyKey: 'retired.delivery.0001', payloadFingerprint: 'a'.repeat(64) },
    86_400_000
  );
  const liveClaim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'retired-task' },
    authentication: null,
    retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  });
  assert.ok(liveClaim);
  await liveClaim.release(0);
  now += 86_400_001;
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'retired-key',
      alg: 'ed25519',
      privateKey: {
        ...privateJwk,
        kid: 'retired-key',
        alg: 'EdDSA',
        key_ops: ['sign'],
        adcp_use: 'request-signing',
      },
    },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryStore,
    deliveryRecovery: recovery,
    now: () => now,
    fetch: async () => {
      throw new Error('retired deliveries must not POST');
    },
  });
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    limit: 1,
    deliver: lease => emitter.emitRecovered(lease),
  });
  assert.deepEqual(result, { claimed: 1, settled: 1, released: 0 });
  assert.deepEqual(await recovery.claimPending({ ownerToken: 'after-retirement', limit: 1 }), []);
});

test('recovery terminalizes a delivery ID already bound to another payload', async () => {
  const deliveryStore = memoryWebhookDeliveryStore();
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const signerKey = {
    keyid: 'conflict-key',
    alg: 'ed25519',
    privateKey: {
      ...privateJwk,
      kid: 'conflict-key',
      alg: 'EdDSA',
      key_ops: ['sign'],
      adcp_use: 'request-signing',
    },
  };
  const emitter = createWebhookEmitter({
    signerKey,
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryStore,
    fetch: async () => ({ status: 204, headers: { get: () => undefined } }),
  });
  await emitter.emit({
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'original-task' },
    delivery_id: 'conflicting-recovery-delivery',
  });
  const key = { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'conflicting-recovery-delivery' };
  const liveClaim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'changed-task' },
    authentication: null,
    retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  });
  assert.ok(liveClaim);
  await liveClaim.release(0);
  const recoveryEmitter = createWebhookEmitter({
    signerKey,
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryStore,
    deliveryRecovery: recovery,
    fetch: async () => {
      throw new Error('conflicting deliveries must not POST');
    },
  });
  const result = await pollWebhookDeliveryRecovery({
    recovery,
    limit: 1,
    deliver: lease => recoveryEmitter.emitRecovered(lease),
  });
  assert.deepEqual(result, { claimed: 1, settled: 1, released: 0 });
  assert.deepEqual(await recovery.claimPending({ ownerToken: 'after-conflict', limit: 1 }), []);
});

test('recovered leases replay through the standard signed emitter without a competing checkpoint', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const key = { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'replay-delivery' };
  const liveClaim = await recovery.checkpoint(key, {
    url: 'https://buyer.invalid/hook',
    payload: { task_id: 'task-replay' },
    authentication: null,
    retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  });
  assert.ok(liveClaim);
  await liveClaim.release(0);
  const [lease] = await recovery.claimPending({ ownerToken: 'replay-worker', leaseMs: 5_000, limit: 1 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'replay-key',
      alg: 'ed25519',
      privateKey: { ...privateJwk, kid: 'replay-key', alg: 'EdDSA', key_ops: ['sign'], adcp_use: 'request-signing' },
    },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryRecovery: recovery,
    fetch: async () => ({ status: 204, headers: { get: () => undefined } }),
  });
  const result = await emitter.emitRecovered(lease);
  assert.equal(result.delivered, true, result.errors.join('; '));
  assert.equal(await lease.settle('delivered'), true, 'poller retains fenced settlement ownership');
});

test('recovery verifies persisted snapshot integrity before resolving secrets', async () => {
  const base = memoryWebhookDeliveryRecoveryBackend();
  const backend = {
    ...base,
    durability: 'durable',
    async claimPending(options) {
      const records = await base.claimPending(options);
      if (records[0]) records[0].snapshot.url = 'https://tampered.invalid';
      return records;
    },
  };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const liveClaim = await recovery.checkpoint(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'integrity-delivery' },
    {
      url: 'https://buyer.invalid',
      payload: {},
      authentication: null,
      retries: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    }
  );
  assert.ok(liveClaim);
  await liveClaim.release(0);
  await assert.rejects(
    () => recovery.claimPending({ ownerToken: 'integrity-worker', limit: 1 }),
    /snapshot integrity check failed/
  );
});

test('PostgreSQL migrations use separate binding and outbox namespaces', () => {
  const delivery = getWebhookDeliveryMigration();
  const recovery = getWebhookDeliveryRecoveryMigration();
  assert.match(delivery, /PRIMARY KEY \(publisher_scope, tenant_scope, delivery_id\)/);
  assert.match(delivery, /status IN \('bound', 'retired'\)/);
  assert.match(recovery, /PRIMARY KEY \(publisher_scope, tenant_scope, delivery_id\)/);
  assert.match(recovery, /lease_claim_id\s+TEXT/);
  assert.match(recovery, /lease_version\s+BIGINT NOT NULL DEFAULT 0/);
  assert.match(recovery, /ADD COLUMN IF NOT EXISTS intent_fingerprint TEXT/);
});

test('PostgreSQL claim is one backend-clock upsert and never overwrites immutable evidence', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [
          {
            status: 'bound',
            idempotency_key: 'idempotency.key.0001',
            payload_fingerprint: 'a'.repeat(64),
            first_attempt_at_ms: '1000',
            retain_until_ms: '2000',
          },
        ],
        rowCount: 1,
      };
    },
  };
  const store = pgWebhookDeliveryStore(db);
  await store.claim(
    { publisherScope: 'p', tenantScope: 't', deliveryId: 'd' },
    { idempotencyKey: 'idempotency.key.0001', payloadFingerprint: 'a'.repeat(64) },
    1000
  );
  assert.match(queries[0].sql, /ON CONFLICT \(publisher_scope, tenant_scope, delivery_id\) DO UPDATE/);
  assert.match(queries[0].sql, /clock_timestamp\(\)/);
  assert.doesNotMatch(queries[0].sql, /idempotency_key\s*=\s*EXCLUDED/i);
});

test('PostgreSQL recovery claims use SKIP LOCKED and fenced owner/version predicates', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const backend = pgWebhookDeliveryRecoveryBackend(db, {
    claimScope: { publisherScope: 'publisher-a', tenantScope: 'tenant-a' },
  });
  await backend.claimPending({ ownerToken: 'owner-token', leaseMs: 1000, limit: 10 });
  await backend.settleLease(
    {
      key: { publisherScope: 'publisher-a', tenantScope: 'tenant-a', deliveryId: 'd' },
      leaseOwner: 'owner-token',
      leaseVersion: 4,
    },
    'delivered'
  );
  assert.match(queries[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(queries[0].sql, /lease_version = outbox\.lease_version \+ 1/);
  assert.match(queries[0].sql, /publisher_scope = \$4 AND tenant_scope = \$5/);
  assert.deepStrictEqual(queries[0].params, ['owner-token', 1000, 10, 'publisher-a', 'tenant-a']);
  assert.match(queries[1].sql, /lease_owner = \$4 AND lease_version = \$5/);
  await assert.rejects(
    backend.settle({ publisherScope: 'publisher-b', tenantScope: 'tenant-a', deliveryId: 'foreign' }, 'terminal'),
    /outside the configured claim scope/
  );
  assert.strictEqual(queries.length, 2, 'out-of-scope mutation fails before reaching PostgreSQL');
});

test('PostgreSQL recovery can fence all tenants under one publisher', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const backend = pgWebhookDeliveryRecoveryBackend(db, {
    claimScope: { publisherScope: 'publisher-a' },
  });
  await backend.claimPending({ ownerToken: 'owner-token', leaseMs: 1000, limit: 10 });
  assert.match(queries[0].sql, /publisher_scope = \$4/);
  assert.doesNotMatch(queries[0].sql, /tenant_scope = \$5/);
  assert.deepStrictEqual(queries[0].params, ['owner-token', 1000, 10, 'publisher-a']);
  await assert.rejects(
    backend.settle({ publisherScope: 'publisher-b', tenantScope: 'tenant-a', deliveryId: 'foreign' }, 'terminal'),
    /outside the configured claim scope/
  );
});

test('Redis and PostgreSQL backends require deployment isolation in production', () => {
  const script = `
    const {
      pgWebhookDeliveryStore,
      pgWebhookDeliveryRecoveryBackend,
      redisWebhookDeliveryStore,
      redisWebhookDeliveryRecoveryBackend,
    } = require(${JSON.stringify(require.resolve('../../dist/lib/server/index.js'))});
    const client = { eval: async () => null, ping: async () => 'PONG' };
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    try { pgWebhookDeliveryStore(db); process.exit(8); }
    catch (error) { if (!/deployment-unique tableName/.test(error.message)) throw error; }
    try { pgWebhookDeliveryRecoveryBackend(db); process.exit(9); }
    catch (error) { if (!/deployment-unique tableName/.test(error.message)) throw error; }
    try { redisWebhookDeliveryStore(client); process.exit(10); }
    catch (error) { if (!/deployment-unique keyPrefix/.test(error.message)) throw error; }
    try { redisWebhookDeliveryRecoveryBackend(client); process.exit(11); }
    catch (error) { if (!/deployment-unique keyPrefix/.test(error.message)) throw error; }
    redisWebhookDeliveryStore(client, { keyPrefix: 'prod-eu:delivery:' });
    redisWebhookDeliveryRecoveryBackend(client, { keyPrefix: 'prod-eu:outbox:' });
    pgWebhookDeliveryStore(db, { tableName: 'prod_eu_webhook_delivery' });
    pgWebhookDeliveryRecoveryBackend(db, { tableName: 'prod_eu_webhook_outbox' });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// Optional live backend contract runs. CI deployments that provide these
// services execute exactly the same semantic suite as memory.
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const suffix = randomBytes(4).toString('hex');
  const deliveryTable = `adcp_wh_delivery_${suffix}`;
  const outboxTable = `adcp_wh_outbox_${suffix}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  after(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${deliveryTable}", "${outboxTable}"`);
    await pool.end();
  });
  runWebhookDeliveryStoreContract('pgWebhookDeliveryStore (live)', async () => {
    await pool.query(getWebhookDeliveryMigration({ tableName: deliveryTable }));
    return pgWebhookDeliveryStore(pool, { tableName: deliveryTable });
  });
  runWebhookRecoveryBackendContract('pgWebhookDeliveryRecoveryBackend (live)', async () => {
    await pool.query(getWebhookDeliveryRecoveryMigration({ tableName: outboxTable }));
    return pgWebhookDeliveryRecoveryBackend(pool, { tableName: outboxTable });
  });
}

if (process.env.REDIS_URL) {
  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  const ready = client.connect();
  const prefix = `adcp:test:webhook:${randomBytes(6).toString('hex')}:`;
  after(async () => {
    await ready;
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(keys);
    await client.quit();
  });
  runWebhookDeliveryStoreContract('redisWebhookDeliveryStore (live)', async () => {
    await ready;
    return redisWebhookDeliveryStore(client, { keyPrefix: `${prefix}delivery:` });
  });
  runWebhookRecoveryBackendContract('redisWebhookDeliveryRecoveryBackend (live)', async () => {
    await ready;
    return redisWebhookDeliveryRecoveryBackend(client, { keyPrefix: `${prefix}outbox:` });
  });
}
