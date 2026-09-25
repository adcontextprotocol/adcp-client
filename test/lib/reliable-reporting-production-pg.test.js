const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe(
  'PostgreSQL Reliable Reporting production service',
  { skip: !DATABASE_URL && 'PostgreSQL URL not set' },
  () => {
    const schema = `adcp_reporting_production_${process.pid}`;
    let bootstrap;
    let pool;
    let service;

    before(async () => {
      const { Pool } = require('pg');
      const reporting = require('../../dist/lib/reporting/service/index.js');
      const source = require('../../dist/lib/reporting/source/index.js');
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
        keyid: 'reporting-production-test',
        alg: 'ed25519',
        privateKey: {
          ...privateKey.export({ format: 'jwk' }),
          kid: 'reporting-production-test',
          alg: 'ed25519',
          adcp_use: 'request-signing',
          key_ops: ['sign'],
        },
      };
      service = await reporting.createPostgresReliableReportingProductionService({
        db: pool,
        namespace: 'reporting-production-test',
        publisherScope: 'reporting-production-test',
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
        managedDelivery: {
          resourceRetentionDays: 90,
          authorizationRevocationSeconds: 60,
          store: { evidenceRetentionDays: 90 },
          adapter: {
            verificationProfiles: ['native_commit'],
            revocationFencesDeliveryGenerations: true,
            deliver: async () => {
              throw new Error('no materialization expected');
            },
            read: async () => new Uint8Array(),
            revoke: async () => {},
          },
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

    test('publishes only the fully probed production feature set', async () => {
      assert.equal(service.setup.component, 'reliable-reporting-production');
      assert.equal(service.capabilities.managed_delivery, true);
      assert.equal(service.capabilities.ledger_notification, 'reporting.ledger_changed');
      assert.equal(service.capabilities.status_notification, 'reporting.status_changed');
      assert.equal(service.capabilities.readiness_notification, 'reporting.delivery_ready');
      assert.equal(service.capabilities.supports_webhook_activity, true);
      assert.equal(service.platform.capabilities, service.capabilities);
      await service.recoverOnce();
    });
  }
);
