const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LIFECYCLE_PG_URL;

describe('reliable reporting lifecycle reference', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_lifecycle_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let sourceApi;
  let reference;
  let request;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../dist/lib/reporting/ledger/index.js');
    sourceApi = require('../dist/lib/reporting/source/index.js');
    const { createReportingLifecycleReference } = require('../examples/reliable-reporting-lifecycle/index.js');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    reference = createReportingLifecycleReference({ pool });
    request = sourceApi.redactedReportingSourceRequestV1();
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('drives waiting, delayed, action-required, zero, restatement, and exact buyer reconciliation', async () => {
    const day = 86_400_000;
    const now = new Date();
    const anchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3);
    const anchor = new Date(anchorMs).toISOString();
    const capabilities = reference.server[Symbol.for('@adcp/client.capabilities')];
    assert.ok(capabilities.compliance_testing.scenarios.includes('reporting_core_lifecycle_probe'));
    const configuration = {
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
        anchor,
        periodMilliseconds: day,
        deliverySlaMilliseconds: day,
        recoveryWindowMilliseconds: 2 * day,
        restatementMilliseconds: [3 * day],
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    const installed = await reference.producer.installConfiguration(configuration);
    await backdateConfiguration(pool, installed, anchor);
    const [first] = await reference.producer.planObligations(new Date(anchorMs + day).toISOString());
    assert.ok(first, 'period close freezes an obligation');
    assert.equal(
      ledger.projectReportingObligationHealthV1(first, [], new Date(anchorMs + day).toISOString()).health,
      'waiting'
    );
    assert.equal(
      ledger.projectReportingObligationHealthV1(first, [], new Date(anchorMs + 2 * day).toISOString()).health,
      'delayed'
    );
    assert.equal(
      ledger.projectReportingObligationHealthV1(first, [], new Date(anchorMs + 4 * day + 1).toISOString()).health,
      'action_required'
    );

    reference.source.notReady();
    const notReady = await reference.controls.reportingCoreLifecycleProbe({
      source: 'not-ready',
      run_worker: true,
      worker_options: {
        now: new Date(anchorMs + 2 * day).toISOString(),
        maxIterations: 1,
        retryDelayMilliseconds: 100,
      },
    });
    assert.equal(notReady.simulated.worker.notReady, 1, JSON.stringify(notReady));
    reference.source.ready();
    const published = await reference.producer.runWorker({
      now: () => new Date(anchorMs + 2 * day + 500),
      maxIterations: 1,
    });
    assert.equal(published.revisionsCommitted, 1, JSON.stringify({ published, source: reference.source.state }));
    const firstRevisions = await reference.store.listRevisions(first.reporting_obligation_id);
    assert.equal(
      ledger.projectReportingObligationHealthV1(first, firstRevisions, new Date(anchorMs + 2 * day + 500).toISOString())
        .health,
      'complete'
    );
    assert.equal(
      ledger.projectReportingObligationHealthV1(
        first,
        firstRevisions,
        new Date(anchorMs + 2 * day + 500).toISOString(),
        false
      ).health,
      'healthy'
    );

    const [second] = await reference.producer.planObligations(new Date(anchorMs + 2 * day).toISOString());
    assert.ok(second, 'the next closed period is planned');
    reference.source.zero();
    assert.equal(
      (
        await reference.producer.runWorker({
          now: () => new Date(anchorMs + 3 * day),
          maxIterations: 1,
        })
      ).revisionsCommitted,
      1
    );
    const zeroRevision = (await reference.store.listRevisions(second.reporting_obligation_id))[0];
    assert.equal(zeroRevision.binding.rowCount, 0, '[] is a real, bound zero-row period');

    reference.source.restate([{ media_buy_id: request.coverage.mediaBuyIds[0], impressions: 12, spend: '1.20' }]);
    await reference.producer.runWorker({ now: () => new Date(anchorMs + 4 * day), maxIterations: 1 });
    const restated = await reference.store.listRevisions(first.reporting_obligation_id);
    assert.equal(restated.length, 2);
    assert.equal(restated[1].supersedes_reporting_revision_id, restated[0].reporting_revision_id);

    const context = { account: { account_id: request.account.account_id }, sessionKey: 'lifecycle-reference-buyer' };
    const exact = await reference.getMediaBuyDelivery(
      { account: request.account, reporting_revision_id: restated[1].reporting_revision_id },
      context
    );
    const bytes = Buffer.from(
      sourceApi.canonicalJsonV1({
        reporting_revision_id: restated[1].reporting_revision_id,
        row_count: exact.reporting_rows.length,
        control_totals: exact.reporting_revision.control_totals,
        reporting_rows: exact.reporting_rows,
      })
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), exact.reporting_revision_binding.content_sha256);

    const [missing] = await reference.producer.planObligations(new Date(anchorMs + 3 * day).toISOString());
    assert.ok(missing);
    assert.deepEqual(await reference.store.listRevisions(missing.reporting_obligation_id), []);
    assert.equal(
      ledger.projectReportingObligationHealthV1(missing, [], new Date(anchorMs + 7 * day + 1).toISOString()).health,
      'action_required'
    );

    const { reconcileReporting } = require('../dist/lib/reporting/reconciliation.js');
    const buyer = await reconcileReporting({
      client: {
        getReportingStatus: input => reference.getReportingStatus(input, context),
        syncReportingReceipts: async () => ({ status: 'completed', results: [] }),
      },
      request: { account: request.account, period: { start: first.period.start, end: first.period.end } },
      expectedPeriods: [],
      now: new Date(),
      inspect: async () => ({
        rowCount: 0,
        controlTotals: [],
        consumerCommitRef: 'lifecycle-reference-buyer',
      }),
    });
    assert.equal(buyer.ledger.obligations.length, 1, 'buyer loaded the exact seller obligation');
    assert.equal(buyer.ledger.revisions.length, 2, 'buyer loaded the immutable Core revision chain');
    assert.ok(
      !buyer.obligations[0].reasons.includes('MISSING_CURRENT_REVISION'),
      'buyer joined the Core revision without requiring a managed materialization'
    );

    const {
      createReportingLifecycleReference,
      createSimulatedReportingSource,
    } = require('../examples/reliable-reporting-lifecycle/index.js');
    const { cadence, ...offeringBase } = sourceApi.redactedReportingSourceOfferingV1;
    const authoritativeOffering = {
      ...offeringBase,
      offeringId: 'fixture-authoritative-lifecycle',
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'P1D',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P1D',
        correctionPolicy: 'immutable_correction',
      },
    };
    const officialSource = createSimulatedReportingSource({ offering: authoritativeOffering });
    officialSource.finalize();
    const officialReference = createReportingLifecycleReference({ pool, source: officialSource });
    const officialAccount = { account_id: 'fixture-official-account' };
    const officialAnchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1);
    const installedOfficial = await officialReference.producer.installConfiguration({
      ...configuration,
      account: officialAccount,
      delivery_config_id: 'fixture-official-delivery',
      delivery_config_version: 1,
      offeringId: authoritativeOffering.offeringId,
      feedPurpose: 'billing',
      requiredFinality: 'official',
      finalityPolicy: {
        policyId: 'fixture-source-final',
        basis: 'source_final',
        sourceSignal: 'get_media_buy_delivery.is_final',
      },
      canonicalization: {
        id: 'fixture-canonical-rows',
        uri: request.contract.schemaUri,
        sha256: request.contract.schemaSha256,
        primaryKeys: ['media_buy_id'],
      },
      schedule: {
        anchor: new Date(officialAnchorMs).toISOString(),
        periodMilliseconds: day,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 3 * day,
        officialAfterMilliseconds: 0,
        restatementMilliseconds: [2 * day],
      },
    });
    await backdateConfiguration(pool, installedOfficial, new Date(officialAnchorMs).toISOString());
    const [officialObligation] = await officialReference.producer.planObligations(
      new Date(officialAnchorMs + day).toISOString(),
      { account_id: officialAccount.account_id }
    );
    assert.equal(
      (
        await officialReference.producer.runWorker({
          now: () => new Date(officialAnchorMs + day),
          maxIterations: 1,
          account_id: officialAccount.account_id,
        })
      ).revisionsCommitted,
      1
    );
    officialSource.restate([{ media_buy_id: request.coverage.mediaBuyIds[0], impressions: 11, spend: '1.10' }]);
    await officialReference.producer.runWorker({
      now: () => new Date(officialAnchorMs + 3 * day),
      maxIterations: 1,
      account_id: officialAccount.account_id,
    });
    const officialRevisions = await officialReference.store.listRevisions(officialObligation.reporting_obligation_id);
    const adjustments = await officialReference.store.listAdjustments(officialObligation.reporting_obligation_id);
    assert.equal(officialRevisions.length, 1);
    assert.equal(officialRevisions[0].finality, 'official');
    assert.equal(adjustments.length, 1);
  });
});

async function backdateConfiguration(pool, configuration, installedAt) {
  const data = { ...configuration, installedAt };
  await pool.query(
    `UPDATE adcp_reporting_configurations
        SET data = $2::jsonb
      WHERE configuration_id = $1`,
    [configuration.configurationId, JSON.stringify(data)]
  );
}
