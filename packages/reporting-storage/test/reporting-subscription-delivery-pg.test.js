/**
 * Managed delivery of subscription obligations on PostgreSQL (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3), through the production service: the engine owes
 * periods, the Core cycle binds each (owner, offering) generation to the owner's destination, the
 * producer executes, and the managed worker delivers with the expanded path_template and
 * account_id on every row. A lost grant stops delivery between claim and settle. Also the
 * additive binding-key migration on a published schema.
 */
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const DAY = 86_400_000;
const ACCOUNT = 'subscription-delivery-account';
const TENANT = 'tenant-1';
const A = { tenantId: TENANT, principalId: 'principal-a' };
const B = { tenantId: TENANT, principalId: 'principal-b' };
const TEMPLATE = '{account_id}/{offering_id}/{period_start}';

/** The published managed binding layout, before bindings were keyed by configuration alone. */
const PUBLISHED_BINDINGS = `
CREATE TABLE adcp_reporting_destination_authorizations (
  account_id TEXT NOT NULL, destination_ref TEXT NOT NULL, generation BIGINT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, cleanup_completed_at TIMESTAMPTZ,
  cleanup_lease_owner TEXT, cleanup_lease_generation BIGINT NOT NULL DEFAULT 0,
  cleanup_lease_expires_at TIMESTAMPTZ, data JSONB NOT NULL,
  PRIMARY KEY (account_id, destination_ref, generation));
CREATE TABLE adcp_reporting_managed_bindings (
  configuration_id TEXT PRIMARY KEY REFERENCES adcp_reporting_configurations(configuration_id),
  account_id TEXT NOT NULL, delivery_config_id TEXT NOT NULL, delivery_config_version INTEGER NOT NULL,
  destination_ref TEXT NOT NULL, authorization_generation BIGINT NOT NULL,
  semantic_fingerprint TEXT NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (account_id, destination_ref, authorization_generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation),
  UNIQUE (account_id, delivery_config_id, delivery_config_version));`;

function principalLifecycle(sdkServer, clock) {
  const store = sdkServer.createPrincipalStateStore({ store: new sdkServer.InMemoryStateStore() });
  const notifications = sdkServer.createPersistentNotificationRuntime({
    store: sdkServer.principalNotificationSubscriptionStore(store),
    proofAdapter: { prove: async () => ({ proved: true }) },
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit(params) {
        return {
          delivery_id: params.delivery_id,
          idempotency_key: params.delivery_id,
          attempts: 1,
          delivered: true,
          terminal: true,
          errors: [],
        };
      },
      async emitRecovered(params) {
        return this.emit(params);
      },
    }),
  });
  let version = 0;
  let ref = 0;
  return sdkServer.createPrincipalLifecycle({
    store,
    notifications,
    agentUrl: 'https://seller.example/mcp',
    resolvePrincipal: ctx => ctx.callerMutationScope,
    issuePrincipalId: scope => `record-${scope.tenantId}-${scope.principalId}`,
    issueConfigurationVersion: () => `cfg-${++version}`,
    issueDestinationRef: () => `dest-ref-${++ref}`,
    now: () => clock.now,
    prepareReportingDestination: ({ destination }) => ({
      state: 'validating',
      configuration: structuredClone(destination),
    }),
    reportingSubscriptions: { listDeliveryConfigIds: () => [] },
  });
}

describe('PostgreSQL managed subscription delivery', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_subscription_delivery_${process.pid}`;
  const published = `adcp_reporting_subscription_binding_${process.pid}`;
  let bootstrap;
  let pool;
  let publishedPool;
  let service;
  let engine;
  let host;
  const deliveries = [];
  const origin = Math.floor(Date.now() / DAY) * DAY - 10 * DAY;
  const day = n => new Date(origin + n * DAY).toISOString();
  const offeringIds = ['subscription-daily-a', 'subscription-daily-b'];

  before(async () => {
    const { Pool } = require('pg');
    const reporting = require('./helpers/service.js');
    const source = require('@adcp/sdk/reporting/source');
    const sdkServer = require('@adcp/sdk/server');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    await bootstrap.query(`CREATE SCHEMA "${published}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    publishedPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${published}"` });

    const clock = { now: new Date(day(0.5)) };
    const lifecycle = principalLifecycle(sdkServer, clock);
    const request = source.redactedReportingSourceRequestV1();
    const adapters = {};
    const deliveryOfferings = [];
    for (const offeringId of offeringIds) {
      const sourceOffering = structuredClone(source.redactedReportingSourceOfferingV1);
      sourceOffering.offeringId = offeringId;
      sourceOffering.publicationNamespace = `reporting-source:${offeringId}`;
      sourceOffering.cadence = {
        ...sourceOffering.cadence,
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'PT0S',
      };
      const deliveryOffering = {
        offering_id: offeringId,
        feed_purpose: 'analytics',
        report_definition_id: sourceOffering.contract.report_definition_id,
        report_definition_uri: sourceOffering.contract.reportDefinitionUri,
        report_definition_sha256: sourceOffering.contract.reportDefinitionSha256,
        reporting_profile: {
          id: sourceOffering.contract.reportingProfile,
          version: sourceOffering.contract.schemaVersion,
          schema_uri: sourceOffering.contract.schemaUri,
          schema_sha256: sourceOffering.contract.schemaSha256,
          schema_dialect: sourceOffering.contract.schemaDialect,
          schema_ref_policy: sourceOffering.contract.schemaRefPolicy,
          grain: sourceOffering.grain,
          primary_keys: ['account_id', 'media_buy_id'],
        },
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
        supported_finality: ['snapshot'],
        reconciliation_mode: 'delivery_only',
        method: {
          pattern: 'file_transfer',
          transport: 's3',
          orchestration: 'producer_managed',
          destination_modes: ['existing'],
          provider: { domain: 'storage.example' },
          format: 'jsonl',
        },
        standard_dimensions: [],
      };
      deliveryOfferings.push(deliveryOffering);
      adapters[offeringId] = {
        sourceOffering,
        deliveryOffering,
        fetchSlice: slice => ({
          reporting_period: { start: slice.start_date, end: slice.end_date },
          currency: 'USD',
          reporting_rows: slice.media_buy_ids.map(mediaBuyId => ({ media_buy_id: mediaBuyId, impressions: 3 })),
        }),
      };
    }

    // Both principals subscribe with the same subscription_id, each to its own destination,
    // resolving both offerings (match all).
    let key = 0;
    for (const [principal, destinationId] of [
      [A, 'dest-a'],
      [B, 'dest-b'],
    ]) {
      const scope = {
        tenant_id: principal.tenantId,
        principal_id: principal.principalId,
        principal_kind: 'buyer_agent',
      };
      const synced = await lifecycle.protocol.syncPrincipal(
        {
          idempotency_key: `subscription-delivery-pg-${String(++key).padStart(4, '0')}`,
          configuration: {
            reporting_destinations: [
              {
                pattern: 'file_transfer',
                destination_id: destinationId,
                active: true,
                provider: { domain: 'storage.example' },
                transport: 's3',
                location: `s3://bucket/${destinationId}`,
                accepted_formats: ['jsonl'],
                accepted_verification_profiles: ['manifest_checksums'],
              },
            ],
            reporting_subscriptions: [
              {
                subscription_id: 'analytics-daily',
                subscription_version: 1,
                active: true,
                scope: { all_authorized_accounts: true },
                selector: {
                  feed_purpose: 'analytics',
                  period_duration: 'P1D',
                  required_finality: 'snapshot',
                  match: 'all',
                },
                reconciliation_mode: 'delivery_only',
                destination: { destination_id: destinationId, path_template: TEMPLATE },
              },
            ],
          },
        },
        { callerMutationScope: scope }
      );
      assert.equal(synced.result.kind, 'applied', JSON.stringify(synced));
      const destination = synced.result.configuration.reporting_destinations[0];
      await lifecycle.transitionDestination(principal, {
        destinationId,
        destinationRef: destination.destination_ref,
        state: 'ready',
      });
    }

    host = { authorized: new Set(['principal-a', 'principal-b']), onDeliver: undefined };
    engine = reporting.createReportingSubscriptionEngineV1(engineOptions());
    function engineOptions() {
      return {
        principal: lifecycle,
        offerings: deliveryOfferings,
        statusRetentionDays: 90,
        now: () => clock.now,
        hooks: {
          listAuthorizedAccounts: principal => ({
            accounts: host.authorized.has(principal.principalId)
              ? [{ account_id: ACCOUNT, authorized_at: new Date(origin - 30 * DAY).toISOString() }]
              : [],
          }),
          listAccountBuys: principal => [
            {
              media_buy_id: `mb-${principal.principalId}`,
              confirmed_at: day(1.5),
              start_time: day(3),
              end_time: day(4),
              packages: [{ package_id: 'pkg', reporting_delivery_offering_ids: offeringIds }],
            },
          ],
          resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
          isPeriodDelivered: () => false,
        },
      };
    }

    const [template] = request.coverage.constituents;
    const constituent = mediaBuyId => ({
      ...structuredClone(template),
      constituentId: `constituent-${mediaBuyId}`,
      mediaBuyId,
      productBinding: { ...structuredClone(template.productBinding), mediaBuyId, bindingId: `binding-${mediaBuyId}` },
    });
    const { currency: _currency, ...sourceSettings } = request.sourceSettings;
    const { privateKey } = generateKeyPairSync('ed25519');
    const signerKey = {
      keyid: 'reporting-subscription-delivery-test',
      alg: 'ed25519',
      privateKey: {
        ...privateKey.export({ format: 'jwk' }),
        kid: 'reporting-subscription-delivery-test',
        alg: 'ed25519',
        adcp_use: 'request-signing',
        key_ops: ['sign'],
      },
    };
    service = await reporting.createPostgresReliableReportingProductionService({
      db: pool,
      namespace: 'reporting-subscription-delivery-test',
      publisherScope: 'reporting-subscription-delivery-test',
      acknowledgeIsolatedDatabase: true,
      adapters,
      contact: { name: 'Reporting operations', email: 'reporting@example.com' },
      automatedRecoveryWindowSeconds: 86_400,
      statusRetentionDays: 90,
      resolveSource: (account, configuration) => ({
        adapterId: configuration.offeringId,
        sourceScope: { network_id: `network-${account.id}` },
        sourceTimezone: 'UTC',
      }),
      resolveCurrency: () => 'USD',
      resolveCoverage: () => ({ constituents: ['mb-principal-a', 'mb-principal-b'].map(constituent) }),
      subscriptions: {
        engine,
        principal: lifecycle,
        resolvePrincipal: context => context.principalScope,
        listSubscriptionPrincipals: () => [A, B],
        resolveSubscriptionConfiguration: () => ({
          requestedMetrics: ['impressions'],
          requestedDimensions: request.requestedDimensions,
          sourceSettings,
        }),
      },
      notifications: {
        subscriptions: { acknowledgeIsolatedDatabase: true },
        webhooks: { signerKey, fetch: async () => ({ status: 204, headers: { get: () => undefined } }) },
        proofAdapter: { prove: async () => ({ proved: true }) },
        authorizeDelivery: async () => ({ authorized: true }),
        validateDestination: async () => ({ allowed: true }),
      },
      activity: { tenantScopeForAccount: accountId => `tenant:${accountId}` },
      resolveWebhookActivityScope: () => ({ tenantId: `tenant:${ACCOUNT}`, principalId: 'principal-a' }),
      managedDelivery: {
        resourceRetentionDays: 90,
        authorizationRevocationSeconds: 60,
        store: { evidenceRetentionDays: 90 },
        adapter: {
          verificationProfiles: ['manifest_checksums'],
          revocationFencesDeliveryGenerations: true,
          deliver: async input => {
            deliveries.push(structuredClone(input));
            await host.onDeliver?.(input);
            const now = Date.now();
            return {
              status: 'delivered',
              resource: {
                resource_ref: `resource-${input.materialization.reporting_materialization_id}`,
                kind: 'manifest',
                location: `reports/${input.delivery_path}/manifest.json`,
                manifest_version: '1.0',
                manifest_sha256: 'f'.repeat(64),
                immutability: 'immutable_location',
                expires_at: new Date(now + 120 * DAY).toISOString(),
              },
              verification: {
                verified_at: new Date(now).toISOString(),
                verification_path: 'destination',
                verification_profile: 'manifest_checksums',
                row_count: input.revision.binding.rowCount,
                control_totals: input.revision.wireRevision.control_totals,
                physical_checksums: [{ object_ref: 'rows.jsonl', algorithm: 'sha256', value: '7'.repeat(64) }],
              },
            };
          },
          read: async () => new Uint8Array(),
          revoke: async () => {},
        },
      },
      applyMigrations: async migrations => {
        for (const migration of migrations) await pool.query(migration);
      },
    });
    clock.now = new Date(day(6));
    await engine.reconcile(A);
    await engine.reconcile(B);
  });

  after(async () => {
    await service?.stop();
    await pool?.end();
    await publishedPool?.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${published}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('delivers each owner’s offerings to its own destination with the expanded path and account_id', async () => {
    // A loses its grant while its first delivery is in flight: nothing of A is recorded as delivered.
    let revoked = false;
    host.onDeliver = async input => {
      if (revoked || input.obligation.subscription.principalId !== 'principal-a') return;
      revoked = true;
      host.authorized.delete('principal-a');
      await engine.authorizationChanged(A, ACCOUNT, { authorized: false, at: new Date().toISOString() });
    };
    const result = await service.runCycle({ accountId: ACCOUNT, maxWorkerIterations: 25 });
    assert.equal(result.core.planned, 4, JSON.stringify(result.core));
    assert.equal(result.core.revisionsCommitted, 4, JSON.stringify(result.core));
    const bindings = await pool.query(
      `SELECT configuration_id, destination_ref, data FROM adcp_reporting_managed_bindings WHERE account_id = $1`,
      [ACCOUNT]
    );
    assert.equal(bindings.rows.length, 4, 'one binding per (owner, offering) under one (account, id, version)');
    const configurations = await pool.query(
      `SELECT configuration_id, data FROM adcp_reporting_configurations WHERE account_id = $1`,
      [ACCOUNT]
    );
    const ownerOf = new Map(configurations.rows.map(row => [row.configuration_id, row.data.subscription.principalId]));
    const refs = new Map();
    for (const row of bindings.rows) {
      assert.equal(row.data.path_template, TEMPLATE);
      assert.equal(row.data.delivery_config_id, 'analytics-daily');
      const owner = ownerOf.get(row.configuration_id);
      refs.set(owner, new Set([...(refs.get(owner) ?? []), row.destination_ref]));
    }
    assert.equal(refs.get('principal-a').size, 1);
    assert.equal(refs.get('principal-b').size, 1);
    assert.notDeepEqual([...refs.get('principal-a')], [...refs.get('principal-b')]);

    // B's two offerings were delivered, each under its own expanded path, rows stamped with account_id.
    const forB = deliveries.filter(value => value.obligation.subscription.principalId === 'principal-b');
    assert.deepEqual(forB.map(value => value.obligation.offeringId).sort(), offeringIds);
    for (const delivery of forB) {
      assert.equal(delivery.binding.destination_ref, [...refs.get('principal-b')][0]);
      assert.equal(
        delivery.delivery_path,
        `${ACCOUNT}/${delivery.obligation.offeringId}/${delivery.obligation.period.start}`
      );
      assert.ok(delivery.revision.rows.length > 0);
      for (const row of delivery.revision.rows) assert.equal(row.account_id, ACCOUNT);
    }
    // A was claimed once, lost authority before settling, and was held, not failed.
    assert.equal(result.managed.heldForAuthority >= 1, true, JSON.stringify(result.managed));
    const materializations = await pool.query(
      `SELECT configuration_id, status FROM adcp_reporting_materializations WHERE account_id = $1`,
      [ACCOUNT]
    );
    for (const row of materializations.rows) {
      if (ownerOf.get(row.configuration_id) === 'principal-a') assert.equal(row.status, 'pending');
      else assert.equal(row.status, 'delivered');
    }
    assert.equal(
      deliveries.filter(value => value.obligation.subscription.principalId === 'principal-a').length,
      1,
      'after the loss no further delivery of A is attempted'
    );
    // A is reported unauthorized; its obligations stay owed.
    const obligations = await pool.query(`SELECT data FROM adcp_reporting_obligations WHERE account_id = $1`, [
      ACCOUNT,
    ]);
    assert.equal(obligations.rows.length, 4);
  });

  test('the binding migration drops the published three-column key on an existing schema', async () => {
    const ledger = require('./helpers/ledger.js');
    await publishedPool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await publishedPool.query(PUBLISHED_BINDINGS);
    const configuration = { configurationId: 'legacy-config', account: { account_id: ACCOUNT } };
    await publishedPool.query(
      `INSERT INTO adcp_reporting_configurations
         (configuration_id, account_id, delivery_config_id, delivery_config_version, semantic_fingerprint, data, created_at)
       VALUES ('legacy-config', $1, 'legacy', 1, 'sha256:legacy', $2::jsonb, clock_timestamp())`,
      [ACCOUNT, JSON.stringify(configuration)]
    );
    await publishedPool.query(
      `INSERT INTO adcp_reporting_destination_authorizations (account_id, destination_ref, generation, authorized_at, data)
       VALUES ($1, 'legacy-dest', 1, clock_timestamp(), '{}'::jsonb)`,
      [ACCOUNT]
    );
    await publishedPool.query(
      `INSERT INTO adcp_reporting_managed_bindings VALUES ('legacy-config', $1, 'legacy', 1, 'legacy-dest', 1, 'sha256:b', '{"legacy":true}'::jsonb, clock_timestamp())`,
      [ACCOUNT]
    );
    const unique = async () =>
      (
        await publishedPool.query(
          `SELECT conname FROM pg_constraint
            WHERE conrelid = 'adcp_reporting_managed_bindings'::regclass AND contype = 'u'`
        )
      ).rows.length;
    assert.equal(await unique(), 1);
    await publishedPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    await publishedPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    assert.equal(await unique(), 0, 'the published three-column key is found by its columns and dropped');
    const kept = await publishedPool.query('SELECT configuration_id, data FROM adcp_reporting_managed_bindings');
    assert.deepEqual(
      kept.rows.map(row => [row.configuration_id, row.data]),
      [['legacy-config', { legacy: true }]]
    );
    // The configuration is still the binding's key.
    await assert.rejects(
      publishedPool.query(
        `INSERT INTO adcp_reporting_managed_bindings VALUES ('legacy-config', $1, 'legacy', 1, 'legacy-dest', 1, 'sha256:c', '{}'::jsonb, clock_timestamp())`,
        [ACCOUNT]
      ),
      /duplicate key value/
    );
  });
});
