const assert = require('node:assert/strict');
const { rowStorageServiceOptionsForTest } = require('./helpers/reporting-row-storage-mode.js');
const { generateKeyPairSync } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

function routeAdapter() {
  return {
    verificationProfiles: ['canonical_digest'],
    revocationFencesDeliveryGenerations: true,
    deliver: async () => {
      throw new Error('no materialization expected');
    },
    read: async () => new Uint8Array(),
    revoke: async () => {},
  };
}

describe(
  'PostgreSQL Reliable Reporting production service with a managed-delivery router',
  { skip: !DATABASE_URL && 'PostgreSQL URL not set' },
  () => {
    const schema = `adcp_reporting_production_router_${process.pid}`;
    let bootstrap;
    let pool;
    let service;
    let webhookActivityScopeCalls = 0;
    const gcsAdapter = routeAdapter();
    const otherAdapter = routeAdapter();
    let router;

    before(async () => {
      const { Pool } = require('pg');
      const ledgerEntry = require('./helpers/ledger.js');
      router = ledgerEntry.createReportingManagedDeliveryAdapterRouterV1({
        routes: [
          { id: 'objects', match: { pattern: 'file_transfer', transport: 'test_object_store' }, adapter: gcsAdapter },
          { id: 'other', match: { pattern: 'file_transfer', transport: 'other_object_store' }, adapter: otherAdapter },
        ],
      });
      const reporting = require('./helpers/service.js');
      const source = require('@adcp/sdk/reporting/source');
      bootstrap = new Pool({ connectionString: DATABASE_URL });
      await bootstrap.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });

      const sourceOffering = structuredClone(source.redactedReportingSourceOfferingV1);
      sourceOffering.cadence = {
        ...sourceOffering.cadence,
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'PT0S',
      };
      const deliveryOffering = {
        offering_id: sourceOffering.offeringId,
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
          primary_keys: ['media_buy_id'],
        },
        schedule: {
          period_duration: 'P1D',
          alignment: 'source_timezone',
          period_timezone_policy: 'fixed',
          period_timezone: 'UTC',
          delivery_sla: 'PT0S',
        },
        supported_finality: ['snapshot'],
        reconciliation_mode: 'delivery_only',
        method: {
          pattern: 'file_transfer',
          transport: 'test_object_store',
          orchestration: 'producer_managed',
          destination_modes: ['existing'],
          provider: { domain: 'files.example' },
          format: 'jsonl',
        },
      };
      const { privateKey } = generateKeyPairSync('ed25519');
      const signerKey = {
        keyid: 'reporting-production-router-test',
        alg: 'ed25519',
        privateKey: {
          ...privateKey.export({ format: 'jwk' }),
          kid: 'reporting-production-router-test',
          alg: 'ed25519',
          adcp_use: 'request-signing',
          key_ops: ['sign'],
        },
      };
      service = await reporting.createPostgresReliableReportingProductionService({
        ...rowStorageServiceOptionsForTest(),
        db: pool,
        namespace: 'reporting-production-router-test',
        publisherScope: 'reporting-production-router-test',
        acknowledgeIsolatedDatabase: true,
        adapters: {
          fixture: {
            sourceOffering,
            deliveryOffering,
            fetchSlice: request => ({
              reporting_period: { start: request.start_date, end: request.end_date },
              currency: 'USD',
              reporting_rows: [],
            }),
          },
        },
        contact: { name: 'Reporting operations', email: 'reporting@example.com' },
        automatedRecoveryWindowSeconds: 86_400,
        statusRetentionDays: 90,
        resolveSource: account => ({
          adapterId: 'fixture',
          sourceScope: { network_id: `network-${account.id}` },
          sourceTimezone: 'UTC',
        }),
        resolveCurrency: () => 'USD',
        resolveCoverage: () => ({ constituents: [] }),
        notifications: {
          subscriptions: { acknowledgeIsolatedDatabase: true },
          webhooks: {
            signerKey,
            fetch: async () => ({ status: 204, headers: { get: () => undefined } }),
          },
          proofAdapter: { prove: async () => ({ proved: true }) },
          authorizeDelivery: async () => ({ authorized: true }),
          validateDestination: async () => ({ allowed: true }),
        },
        activity: { tenantScopeForAccount: accountId => `tenant:${accountId}` },
        resolveWebhookActivityScope: () => {
          webhookActivityScopeCalls += 1;
          return {
            tenantId: 'tenant:account-1',
            principalId: 'buyer-principal-1',
          };
        },
        managedDelivery: {
          resourceRetentionDays: 90,
          authorizationRevocationSeconds: 60,
          store: { evidenceRetentionDays: 90 },
          adapter: router,
        },
        applyMigrations: async migrations => {
          for (const migration of migrations) await pool.query(migration);
        },
      });
    });

    after(async () => {
      await service?.stop();
      if (pool) await pool.end();
      if (bootstrap) {
        await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await bootstrap.end();
      }
    });

    test('accepts the router as its managed-delivery adapter and publishes managed delivery', async () => {
      assert.equal(service.capabilities.managed_delivery, true);
      assert.equal(service.capabilities.offerings[0].method.transport, 'test_object_store');
      assert.equal(service.managed.reportingDeliveryCapabilities.managed_delivery, true);
    });

    test('refuses at install a binding the router cannot route or verify', async () => {
      const binding = overrides =>
        require('./helpers/ledger.js').reportingManagedDeliveryBindingV1({
          configurationId: 'configuration-router-production',
          account_id: 'account-1',
          delivery_config_id: 'files',
          delivery_config_version: 1,
          destination_ref: 'destination-1',
          authorization_generation: 1,
          feed_purpose: 'analytics',
          method: 'file_transfer',
          transport: 'azure_blob',
          verification_profile: 'canonical_digest',
          reconciliation_mode: 'delivery_only',
          resource_retention_days: 30,
          ...overrides,
        });
      await assert.rejects(
        () => service.stores.managed.installBinding(binding({ transport: 'azure_blob' })),
        error => error.code === 'REPORTING_ROUTE_NOT_FOUND'
      );
      await assert.rejects(
        () =>
          service.stores.managed.installBinding(
            binding({ transport: 'other_object_store', verification_profile: 'native_commit' })
          ),
        error => error.code === 'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED'
      );
    });

    test('reports per-route counts in the worker result', async () => {
      const result = await service.managed.runWorker({ maxIterations: 1 });
      assert.deepEqual(Object.keys(result).sort(), [
        'claimed',
        'delivered',
        'deliveriesByRoute',
        'deliveryFailuresByRoute',
        'exhausted',
        'failed',
        'overdueByRoute',
        'planned',
        'revocationFailuresByRoute',
        'revocationsByRoute',
        'revocationsCompleted',
        'revocationsOverdue',
      ]);
    });
  }
);
