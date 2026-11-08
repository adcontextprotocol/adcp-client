const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { after, before, describe, test } = require('node:test');
const { rowStorageServiceOptionsForTest } = require('./helpers/reporting-row-storage-mode.js');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

describe(
  'PostgreSQL production service with an issueObserver',
  { skip: !DATABASE_URL && 'PostgreSQL URL not set' },
  () => {
    const schema = `adcp_issue_observer_production_${process.pid}`;
    let bootstrap;
    let pool;
    let reporting;
    let ledger;
    let sdk;
    let reference;
    let obligation;
    let revision;
    let request;
    let service;
    let plainService;
    let sync;
    let observerMode = 'ok';
    const seen = [];

    function options(extra) {
      const source = require('@adcp/sdk/reporting/source');
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
        keyid: 'issue-observer-production-test',
        alg: 'ed25519',
        privateKey: {
          ...privateKey.export({ format: 'jwk' }),
          kid: 'issue-observer-production-test',
          alg: 'ed25519',
          adcp_use: 'request-signing',
          key_ops: ['sign'],
        },
      };
      return {
        ...rowStorageServiceOptionsForTest(),
        db: pool,
        namespace: 'issue-observer-production-test',
        publisherScope: 'issue-observer-production-test',
        acknowledgeIsolatedDatabase: true,
        adapters: {
          fixture: {
            sourceOffering,
            deliveryOffering,
            fetchSlice: req => ({
              reporting_period: { start: req.start_date, end: req.end_date },
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
          webhooks: { signerKey, fetch: async () => ({ status: 204, headers: { get: () => undefined } }) },
          proofAdapter: { prove: async () => ({ proved: true }) },
          authorizeDelivery: async () => ({ authorized: true }),
          validateDestination: async () => ({ allowed: true }),
        },
        activity: { tenantScopeForAccount: accountId => `tenant:${accountId}` },
        resolveWebhookActivityScope: () => ({ tenantId: 'tenant:account-1', principalId: 'buyer-principal-1' }),
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
        ...extra,
      };
    }

    before(async () => {
      const { Pool } = require('pg');
      reporting = require('./helpers/service.js');
      ledger = require('./helpers/ledger.js');
      sdk = require('@adcp/sdk/reporting/ledger');
      const sourceApi = require('@adcp/sdk/reporting/source');
      const { createReportingLifecycleReference } = require('../examples/reliable-reporting-lifecycle/index.js');
      bootstrap = new Pool({ connectionString: DATABASE_URL });
      await bootstrap.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });

      service = await reporting.createPostgresReliableReportingProductionService(
        options({
          issueObserver: event => {
            seen.push(event);
            if (observerMode === 'throw-once') {
              observerMode = 'ok';
              throw new Error('observer down');
            }
            if (observerMode === 'throw-always') throw new Error('observer down');
          },
        })
      );
      plainService = await reporting.createPostgresReliableReportingProductionService(options({}));

      // An obligation with one committed revision, written through the lifecycle reference on the same schema.
      reference = createReportingLifecycleReference({ pool });
      request = sourceApi.redactedReportingSourceRequestV1();
      const day = 86_400_000;
      const today = new Date();
      const anchorMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 2);
      let configuration = await reference.producer.installConfiguration({
        account: request.account,
        sourceScope: request.sourceScope,
        delivery_config_id: request.delivery_config_id,
        delivery_config_version: request.delivery_config_version,
        offeringId: reference.source.offering.offeringId,
        report_definition_id: request.report_definition_id,
        feedPurpose: 'analytics',
        requiredFinality: 'snapshot',
        requestedMetrics: request.requestedMetrics,
        requestedDimensions: request.requestedDimensions,
        constituents: request.coverage.constituents,
        mediaBuyIds: request.coverage.mediaBuyIds,
        sourceTimezone: 'UTC',
        schedule: {
          anchor: new Date(anchorMs).toISOString().replace('.000Z', '.0001Z'),
          periodMilliseconds: day,
          deliverySlaMilliseconds: 0,
          recoveryWindowMilliseconds: day,
        },
        sourceSettings: request.sourceSettings,
        contract: request.contract,
      });
      configuration = { ...configuration, installedAt: new Date(anchorMs).toISOString() };
      await pool.query('UPDATE adcp_reporting_configurations SET data = $2::jsonb WHERE configuration_id = $1', [
        configuration.configurationId,
        JSON.stringify(configuration),
      ]);
      [obligation] = await reference.producer.planObligations(new Date(anchorMs + day).toISOString());
      await reference.producer.runWorker({ now: () => new Date(anchorMs + day + 1), maxIterations: 1 });
      [revision] = await reference.store.listRevisions(obligation.reporting_obligation_id);
      sync = ledger.createSyncReportingStatusHandler(reference.store, {
        resolveConsumerId: context => context.consumer,
      });
    });

    after(async () => {
      await service?.stop();
      await plainService?.stop();
      if (pool) await pool.end();
      if (bootstrap) {
        await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await bootstrap.end();
      }
    });

    /** A conflicting statement: the consumer says the revision is missing. */
    async function fileConflict(consumer) {
      const id = `issue-observer-production-${consumer}`;
      const response = await sync(
        {
          account: request.account,
          idempotency_key: `key-${id}`,
          statuses: [
            {
              reporting_status_id: id,
              delivery_config_id: obligation.delivery_config_id,
              delivery_config_version: obligation.delivery_config_version,
              report_definition_id: obligation.report_definition_id,
              period: {
                start: obligation.period.start,
                end: obligation.period.end,
                source_timezone: obligation.period.sourceTimezone,
              },
              consumer_status: 'revision_missing',
              reporting_obligation_id: obligation.reporting_obligation_id,
              status_as_of: new Date().toISOString(),
            },
          ],
        },
        { account: request.account, consumer }
      );
      assert.equal(response.results[0].result, 'recorded', JSON.stringify(response));
      const events = await pool.query(
        'SELECT event_id, issue_id, kind FROM adcp_reporting_issue_events WHERE consumer_id = $1 ORDER BY seq',
        [consumer]
      );
      assert.deepEqual(
        events.rows.map(row => row.kind),
        ['opened']
      );
      return events.rows[0];
    }

    test('setup.migrations carries the issue-event migration only when an issueObserver is set', () => {
      assert.ok(service.setup.migrations.includes(ledger.REPORTING_ISSUE_EVENTS_MIGRATION));
      assert.ok(!plainService.setup.migrations.includes(ledger.REPORTING_ISSUE_EVENTS_MIGRATION));
    });

    test('the observer starts through applyMigrations alone, and runCycle delivers an opened occurrence', async () => {
      assert.equal(await reference.store.issueEventsReady(), true);
      const opened = await fileConflict('consumer-deliver');
      const result = await service.runCycle({ deploymentWide: true });
      assert.ok(result.core.issueEvents.delivered >= 1, JSON.stringify(result.core.issueEvents));
      assert.deepEqual(result.core.issueEvents.errors, []);
      const event = seen.find(value => value.eventId === opened.event_id);
      assert.ok(event, 'the observer received the event');
      assert.equal(event.kind, 'opened');
      assert.equal(event.issueId, opened.issue_id);
      assert.equal(event.accountId, request.account.account_id);
      assert.equal(event.consumerId, 'consumer-deliver');
      assert.equal(event.attempt, 1);
    });

    test('a failing observer does not fail the cycle, reaches onError under start(), and is redelivered', async () => {
      // One failure through runCycle: it resolves, and the error is typed.
      observerMode = 'throw-once';
      const opened = await fileConflict('consumer-retry');
      const failed = await service.runCycle({ deploymentWide: true });
      assert.equal(failed.core.issueEvents.failed, 1);
      assert.equal(failed.core.issueEvents.delivered, 0);
      const [error] = failed.core.issueEvents.errors;
      assert.ok(error instanceof sdk.ReportingIssueObserverError);
      assert.equal(error.component, 'issue_observer');
      assert.equal(error.eventId, opened.event_id);

      // The retry backoff defaults to 30 s and the production service does not expose it, so make the
      // event due now instead of sleeping through the backoff.
      await pool.query('UPDATE adcp_reporting_issue_events SET due_at = clock_timestamp() WHERE delivered_at IS NULL');
      const retried = await service.runCycle({ deploymentWide: true });
      assert.ok(retried.core.issueEvents.delivered >= 1);
      const attempts = seen.filter(value => value.eventId === opened.event_id);
      assert.deepEqual(
        attempts.map(value => value.attempt),
        [1, 2]
      );

      // The scheduler hands the same failure to onError.
      observerMode = 'throw-always';
      await fileConflict('consumer-scheduler');
      const errors = [];
      service.start({
        deploymentWide: true,
        intervalMilliseconds: 50,
        onError: scheduled => void errors.push(scheduled),
      });
      try {
        for (
          let waited = 0;
          waited < 10_000 && !errors.some(value => value instanceof sdk.ReportingIssueObserverError);
          waited += 50
        ) {
          await sleep(50);
        }
      } finally {
        observerMode = 'ok';
        await service.stop();
      }
      const observed = errors.find(value => value instanceof sdk.ReportingIssueObserverError);
      assert.ok(observed, `onError received: ${errors.map(value => value?.message)}`);
      assert.equal(observed.component, 'issue_observer');
    });
  }
);
