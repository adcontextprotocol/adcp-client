/**
 * The storage facade (`@adcp/sdk/storage`, experimental, AdCP 3.3): one `ReportingStorage` covers the
 * ledger, principal records, reporting-subscription engine state and the buyer consumer's state;
 * durability is read from the store, never a flag; process-local storage is refused in production; the
 * service runs `checkSchema()` before its first cycle.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const pkg = require('../../package.json');
const storageApi = require('@adcp/sdk/storage');
const { createReliableReportingService } = require('@adcp/sdk/reporting/service');
const { createReliableReportingConsumerV1 } = require('@adcp/sdk/reporting/consumer');
const { createReportingSubscriptionEngineStateStoreV1 } = require('@adcp/sdk/reporting/advanced');
const { InMemoryStateStore, PostgresStateStore, createPrincipalStateStore } = require('@adcp/sdk/server');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');

function withNodeEnv(value, run) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return run();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

function serviceOptions(extra) {
  const source = redactedReportingSourceOfferingV1;
  const request = redactedReportingSourceRequestV1();
  const sourceOffering = structuredClone(source);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  return {
    adapters: {
      fixture: {
        sourceOffering,
        deliveryOffering: {
          offering_id: source.offeringId,
          feed_purpose: 'analytics',
          report_definition_id: source.contract.report_definition_id,
          report_definition_uri: source.contract.reportDefinitionUri,
          report_definition_sha256: source.contract.reportDefinitionSha256,
          reporting_profile: {
            id: source.contract.reportingProfile,
            version: source.contract.schemaVersion,
            schema_uri: source.contract.schemaUri,
            schema_sha256: source.contract.schemaSha256,
            schema_dialect: source.contract.schemaDialect,
            schema_ref_policy: source.contract.schemaRefPolicy,
            grain: source.grain,
            primary_keys: ['media_buy_id'],
          },
          schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
          supported_finality: ['snapshot'],
          reconciliation_mode: 'delivery_only',
        },
        fetchSlice: () => ({ reporting_period: {}, currency: 'USD', reporting_rows: [] }),
      },
    },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: source.retentionDays,
    resolveSource: () => ({ adapterId: 'fixture', sourceScope: { network_id: 'n' }, sourceTimezone: 'UTC' }),
    resolveCurrency: () => 'USD',
    resolveCoverage: () => ({ constituents: request.coverage.constituents }),
    ...extra,
  };
}

describe('@adcp/sdk/storage', () => {
  test('publishes runtime and declaration paths like the other subpaths', () => {
    assert.deepEqual(pkg.exports['./storage'], {
      import: { types: './dist/lib/storage/index.d.mts', default: './dist/lib/storage/index.mjs' },
      require: { types: './dist/lib/storage/index.d.ts', default: './dist/lib/storage/index.js' },
    });
    assert.deepEqual(pkg.typesVersions['*'].storage, ['dist/lib/storage/index.d.ts']);
    const distRoot = path.join(__dirname, '..', '..', 'dist', 'lib', 'storage');
    for (const file of ['index.js', 'index.mjs', 'index.d.ts', 'index.d.mts']) {
      assert.ok(fs.existsSync(path.join(distRoot, file)), `dist/lib/storage/${file} must exist`);
    }
    assert.match(fs.readFileSync(path.join(distRoot, 'index.d.ts'), 'utf8'), /@experimental/);
    for (const name of ['memoryStorage', 'developmentEnvironment', 'requireDurable', 'isReportingStorage']) {
      assert.equal(typeof storageApi[name], 'function', name);
    }
    // The PostgreSQL half lives in @adcp/reporting-storage: the SDK never names a driver.
    assert.equal(storageApi.postgresStorage, undefined);
  });

  test('memoryStorage() is one process-local object covering every reporting store', async () => {
    const storage = storageApi.memoryStorage();
    assert.equal(storage.durability, 'process-local');
    assert.ok(storageApi.isReportingStorage(storage));
    assert.equal(storage.principals.durability, 'process-local');
    assert.equal(storage.subscriptions.durability, 'process-local');
    assert.equal(typeof storage.ledger.putConfiguration, 'function');
    for (const role of ['checkpointStore', 'pendingConsumerStatusStore', 'changesCheckpointStore', 'workLeases']) {
      assert.equal(typeof storage.consumer[role], 'object', role);
    }
    await storage.checkSchema();
    await storage.close();
    assert.equal(storageApi.isReportingStorage({ durability: 'durable' }), false);
  });

  test('development is NODE_ENV test or development, and requireDurable refuses otherwise', () => {
    assert.deepEqual([...storageApi.DEVELOPMENT_ENVIRONMENTS].sort(), ['development', 'test']);
    assert.equal(storageApi.developmentEnvironment(), true);
    withNodeEnv('production', () => {
      assert.equal(storageApi.developmentEnvironment(), false);
      assert.throws(() => storageApi.requireDurable(false, { stores: 'memoryStorage()' }), {
        name: 'PlatformConfigError',
        code: 'REPORTING_STORAGE_NOT_DURABLE',
        message: /postgresStorage\(\{ pool \}\).*NODE_ENV=development/,
      });
      storageApi.requireDurable(true, { stores: 'postgresStorage()' });
    });
  });

  test('the memory consumer persistence fences writes with the current lease', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const { consumer } = storageApi.memoryStorage({ now: () => new Date(now) });
    const key = { consumerScope: 'seller:principal', accountId: 'acc' };
    const lease = await consumer.workLeases.claim({ key, ownerToken: 'owner-a', leaseMilliseconds: 1_000 });
    assert.equal(lease.generation, 1);
    assert.equal(await consumer.workLeases.claim({ key, ownerToken: 'owner-b', leaseMilliseconds: 1_000 }), null);
    assert.equal(await consumer.changesCheckpointStore.compareAndSet(key, null, 'c1', lease), 'applied');
    assert.equal(await consumer.changesCheckpointStore.compareAndSet(key, 'c1', 'c1', lease), 'unchanged');
    assert.equal(await consumer.changesCheckpointStore.compareAndSet(key, 'stale', 'c2', lease), 'conflict');
    now += 2_000;
    // The lease expired: another owner claims it, and the old lease can no longer write.
    const next = await consumer.workLeases.claim({ key, ownerToken: 'owner-b', leaseMilliseconds: 1_000 });
    assert.equal(next.generation, 2);
    assert.equal(await consumer.changesCheckpointStore.compareAndSet(key, 'c1', 'c2', lease), 'conflict');
    assert.equal(await consumer.changesCheckpointStore.compareAndSet(key, 'c1', 'c2', next), 'applied');
    assert.deepEqual(await consumer.changesCheckpointStore.get(key), { checkpoint: 'c2', generation: 2 });
    await assert.rejects(
      consumer.pendingConsumerStatusStore.put({ ...key, chain: 'x' }, { status: 'pending' }, lease),
      /no longer current/
    );
    const identity = { ...key, idempotencyKey: 'n1', payloadSha256: 'a'.repeat(64) };
    assert.equal(await consumer.notifications.isProcessed(identity), false);
    await consumer.notifications.markProcessed(identity);
    assert.equal(await consumer.notifications.isProcessed(identity), true);
    await assert.rejects(
      consumer.notifications.isProcessed({ ...identity, payloadSha256: 'b'.repeat(64) }),
      /different content/
    );
  });
});

describe('durability is intrinsic to the store', () => {
  const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }) };

  test('state stores declare it and the stores built over them inherit it', () => {
    assert.equal(new InMemoryStateStore().durability, 'process-local');
    assert.equal(new PostgresStateStore(fakeDb).durability, 'durable');
    assert.equal(createPrincipalStateStore({ store: new PostgresStateStore(fakeDb) }).durability, 'durable');
    assert.equal(
      createReportingSubscriptionEngineStateStoreV1({ store: new PostgresStateStore(fakeDb) }).durability,
      'durable'
    );
    assert.equal(createPrincipalStateStore({ store: new InMemoryStateStore() }).durability, 'process-local');
  });

  test('the deprecated option is accepted when it agrees and refused when it contradicts', () => {
    assert.equal(
      createPrincipalStateStore({ store: new PostgresStateStore(fakeDb), durability: 'durable' }).durability,
      'durable'
    );
    assert.throws(
      () => createPrincipalStateStore({ store: new PostgresStateStore(fakeDb), durability: 'process-local' }),
      /cannot be declared process-local/
    );
    assert.throws(
      () => createReportingSubscriptionEngineStateStoreV1({ store: new InMemoryStateStore(), durability: 'durable' }),
      { name: 'PlatformConfigError', code: 'REPORTING_STORAGE_NOT_DURABLE', message: /cannot be declared durable/ }
    );
    // A custom store that declares nothing keeps the caller's declaration (absent reads process-local).
    const backing = new InMemoryStateStore();
    const custom = {
      get: backing.get.bind(backing),
      put: backing.put.bind(backing),
      patch: backing.patch.bind(backing),
      delete: backing.delete.bind(backing),
      list: backing.list.bind(backing),
      getWithVersion: backing.getWithVersion.bind(backing),
      putIfMatch: backing.putIfMatch.bind(backing),
    };
    assert.equal(createPrincipalStateStore({ store: custom }).durability, 'process-local');
    assert.equal(createPrincipalStateStore({ store: custom, durability: 'durable' }).durability, 'durable');
    assert.equal(createPrincipalStateStore({ store: { ...custom, durability: 'durable' } }).durability, 'durable');
  });
});

describe('the service and the consumer take one storage', () => {
  test('storage supplies the ledger; storage and store together, or neither, are refused', () => {
    const storage = storageApi.memoryStorage();
    const service = createReliableReportingService(serviceOptions({ storage }));
    assert.equal(service.storage, storage);
    assert.throws(() => createReliableReportingService(serviceOptions({ storage, store: storage.ledger })), {
      name: 'PlatformConfigError',
      configField: 'store',
    });
    assert.throws(() => createReliableReportingService(serviceOptions({})), {
      name: 'PlatformConfigError',
      configField: 'storage',
      message: /memoryStorage\(\).*postgresStorage/,
    });
    assert.throws(() => createReliableReportingService(serviceOptions({ storage: { durability: 'durable' } })), {
      configField: 'storage',
    });
  });

  test('memoryStorage() is refused in production with REPORTING_STORAGE_NOT_DURABLE', () => {
    withNodeEnv('production', () => {
      assert.throws(() => createReliableReportingService(serviceOptions({ storage: storageApi.memoryStorage() })), {
        name: 'PlatformConfigError',
        code: 'REPORTING_STORAGE_NOT_DURABLE',
      });
    });
  });

  test('the first cycle runs checkSchema once, and a behind schema fails the cycle until it is fixed', async () => {
    let checks = 0;
    let behind = true;
    const storage = {
      ...storageApi.memoryStorage(),
      async checkSchema() {
        checks += 1;
        if (behind) {
          const error = new Error('The reporting schema is behind this release (pending: 0002).');
          error.code = 'REPORTING_SCHEMA_BEHIND';
          throw error;
        }
      },
    };
    const service = createReliableReportingService(serviceOptions({ storage }));
    await assert.rejects(service.runCycle({ deploymentWide: true }), { code: 'REPORTING_SCHEMA_BEHIND' });
    behind = false;
    await service.runCycle({ deploymentWide: true });
    await service.runCycle({ deploymentWide: true });
    assert.equal(checks, 2, 'a failed check is retried; a passed one is not repeated');
  });

  test('subscriptions.principal needs storage, and is exclusive with principals', () => {
    const principal = { agentUrl: 'https://seller.example/mcp', notifications: {}, resolvePrincipal: () => ({}) };
    assert.throws(
      () =>
        createReliableReportingService(
          serviceOptions({ store: storageApi.memoryStorage().ledger, subscriptions: { principal, configure() {} } })
        ),
      { name: 'PlatformConfigError', configField: 'storage' }
    );
    assert.throws(
      () =>
        createReliableReportingService(
          serviceOptions({
            storage: storageApi.memoryStorage(),
            subscriptions: { configure() {} },
          })
        ),
      { name: 'PlatformConfigError', message: /principal: \{ agentUrl, notifications, resolvePrincipal \}/ }
    );
  });

  test('the buyer consumer takes storage as its persistence', async () => {
    const storage = storageApi.memoryStorage();
    const consumer = createReliableReportingConsumerV1({ accounts: [], storage, ownerToken: 'owner-token-1' });
    assert.equal(typeof consumer.start, 'function');
    assert.throws(
      () =>
        createReliableReportingConsumerV1({
          accounts: [],
          storage,
          persistence: storage.consumer,
          ownerToken: 'owner-token-1',
        }),
      /not both/
    );
    assert.throws(() => createReliableReportingConsumerV1({ accounts: [], ownerToken: 'owner-token-1' }), /storage/);
    // Like the seller, a buyer refuses process-local storage in production.
    withNodeEnv('production', () => {
      assert.throws(() => createReliableReportingConsumerV1({ accounts: [], storage, ownerToken: 'owner-token-1' }), {
        code: 'REPORTING_STORAGE_NOT_DURABLE',
        message: /postgresStorage/,
      });
      // Fail closed, like the seller: storage that does not declare itself durable is refused too.
      assert.throws(
        () =>
          createReliableReportingConsumerV1({
            accounts: [],
            storage: { consumer: storage.consumer },
            ownerToken: 'owner-token-1',
          }),
        { code: 'REPORTING_STORAGE_NOT_DURABLE' }
      );
    });
  });
});
