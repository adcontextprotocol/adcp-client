const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('sync_reporting_status preview ingest', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_status_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let sourceApi;
  let reference;
  let request;
  let configuration;
  let obligation;
  let revision;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    sourceApi = require('../../dist/lib/reporting/source/index.js');
    const { createReportingLifecycleReference } = require('../../examples/reliable-reporting-lifecycle/index.js');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    reference = createReportingLifecycleReference({ pool });
    request = sourceApi.redactedReportingSourceRequestV1();
    const day = 86_400_000;
    const today = new Date();
    const anchorMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 2);
    configuration = await reference.producer.installConfiguration({
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
        restatementMilliseconds: [2 * day],
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    assert.equal(configuration.schedule.anchor, new Date(anchorMs).toISOString());
    configuration = { ...configuration, installedAt: new Date(anchorMs).toISOString() };
    await pool.query('UPDATE adcp_reporting_configurations SET data = $2::jsonb WHERE configuration_id = $1', [
      configuration.configurationId,
      JSON.stringify(configuration),
    ]);
    [obligation] = await reference.producer.planObligations(new Date(anchorMs + day).toISOString());
    await reference.producer.runWorker({ now: () => new Date(anchorMs + day + 1), maxIterations: 1 });
    [revision] = await reference.store.listRevisions(obligation.reporting_obligation_id);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('enforces exact-leaf supersession and isolates mismatch readback by consumer', async () => {
    const revisionMetadata = await reference.store.getRevisionMetadata(
      revision.reporting_revision_id,
      request.account.account_id
    );
    assert.ok(revisionMetadata);
    assert.equal('rows' in revisionMetadata, false, 'ingest validation does not materialize revision rows');
    const consumerA = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-a' };
    const consumerB = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-b' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: context => context.consumer,
    });
    const status = ledger.createReportingStatusHandler(reference.store, {
      resolveConsumerId: context => context.consumer,
    });
    const initialSnapshot = await status(
      {
        account: request.account,
        view: 'periods',
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.equal(initialSnapshot.periods[0].consumer_status_count, 0);
    const base = {
      delivery_config_id: obligation.delivery_config_id,
      delivery_config_version: obligation.delivery_config_version,
      report_definition_id: obligation.report_definition_id,
      period: {
        start: obligation.period.start,
        end: obligation.period.end,
        source_timezone: obligation.period.sourceTimezone,
      },
      reporting_obligation_id: obligation.reporting_obligation_id,
      reporting_revision_id: revision.reporting_revision_id,
      observed_revision_content_sha256: revision.wireRevision.revision_content_sha256,
      consumer_status: 'received',
      status_as_of: new Date().toISOString(),
      seller_ledger_snapshot_id: initialSnapshot.ledger_snapshot_id,
      seller_ledger_as_of: initialSnapshot.ledger_as_of,
    };
    const firstRequest = {
      account: request.account,
      idempotency_key: 'fixture-status-batch-0001',
      statuses: [{ ...base, reporting_status_id: 'fixture-status-a-0001' }],
    };
    const exactConsumer = {
      account: { account_id: request.account.account_id },
      consumer: 'fixture-consumer-exact-revision',
    };
    const exactSnapshot = await status(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revision.reporting_revision_id,
        pagination: { max_results: 100 },
      },
      exactConsumer
    );
    assert.ok(Date.now() - Date.parse(obligation.period.start) > 86_400_000);
    const exactProvenance = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-exact-snapshot',
        statuses: [
          {
            ...base,
            reporting_status_id: 'fixture-status-exact-0001',
            seller_ledger_snapshot_id: exactSnapshot.ledger_snapshot_id,
            seller_ledger_as_of: exactSnapshot.ledger_as_of,
          },
        ],
      },
      exactConsumer
    );
    assert.equal(exactProvenance.results[0].result, 'recorded');
    const overlapConsumer = {
      account: { account_id: request.account.account_id },
      consumer: 'fixture-consumer-overlap-snapshot',
    };
    const overlapSnapshot = await status(
      {
        account: request.account,
        view: 'periods',
        period: {
          start: new Date(
            Date.parse(obligation.period.start) + configuration.schedule.periodMilliseconds / 2
          ).toISOString(),
          end: obligation.period.end,
        },
        pagination: { max_results: 100 },
      },
      overlapConsumer
    );
    const overlapProvenance = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-overlap-snapshot',
        statuses: [
          {
            ...base,
            reporting_status_id: 'fixture-status-overlap-0001',
            seller_ledger_snapshot_id: overlapSnapshot.ledger_snapshot_id,
            seller_ledger_as_of: overlapSnapshot.ledger_as_of,
          },
        ],
      },
      overlapConsumer
    );
    assert.equal(overlapProvenance.results[0].result, 'recorded');

    const finalityConsumer = {
      account: { account_id: request.account.account_id },
      consumer: 'fixture-consumer-finality-snapshot',
    };
    const finalitySnapshot = await reference.store.createSnapshot({
      account_id: request.account.account_id,
      consumer_id: finalityConsumer.consumer,
      view: 'periods',
      period: { start: obligation.period.start, end: obligation.period.end },
      finality: ['official'],
    });
    const hiddenRevisionProvenance = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-hidden-finality',
        statuses: [
          {
            ...base,
            reporting_status_id: 'fixture-status-hidden-finality',
            seller_ledger_snapshot_id: finalitySnapshot.snapshotId,
            seller_ledger_as_of: finalitySnapshot.ledgerAsOf,
          },
        ],
      },
      finalityConsumer
    );
    assert.equal(
      hiddenRevisionProvenance.results[0].result,
      'failed',
      'snapshot provenance cannot authorize a revision hidden by its finality filter'
    );

    const exactFinalityConsumer = {
      account: { account_id: request.account.account_id },
      consumer: 'fixture-consumer-exact-finality',
    };
    const exactFinalitySnapshot = await reference.store.createSnapshot({
      account_id: request.account.account_id,
      consumer_id: exactFinalityConsumer.consumer,
      view: 'revision',
      reporting_revision_id: revision.reporting_revision_id,
      finality: ['official'],
    });
    const exactFinalityProvenance = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-exact-finality',
        statuses: [
          {
            ...base,
            reporting_status_id: 'fixture-status-exact-finality',
            seller_ledger_snapshot_id: exactFinalitySnapshot.snapshotId,
            seller_ledger_as_of: exactFinalitySnapshot.ledgerAsOf,
          },
        ],
      },
      exactFinalityConsumer
    );
    assert.equal(
      exactFinalityProvenance.results[0].result,
      'recorded',
      'revision-view provenance mirrors the exact read even when periods-only finality filters are present'
    );
    const first = await sync(firstRequest, consumerA);
    assert.equal(first.results[0].result, 'recorded');
    const revisionReadback = await status(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revision.reporting_revision_id,
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.equal(revisionReadback.consumer_statuses.length, 1);
    assert.equal(revisionReadback.consumer_statuses[0].reporting_status_id, 'fixture-status-a-0001');
    assert.equal(revisionReadback.pagination.has_more, false);
    const { seller_ledger_snapshot_id, seller_ledger_as_of, ...baseWithoutSnapshot } = base;
    assert.ok(seller_ledger_snapshot_id && seller_ledger_as_of);
    await pool.query("UPDATE adcp_reporting_snapshots SET expires_at = clock_timestamp() - INTERVAL '1 second'");
    assert.equal(
      (await sync(firstRequest, consumerA)).results[0].result,
      'recorded',
      'an exact batch replay returns the original result'
    );
    assert.equal(
      (await sync({ ...firstRequest, context: { correlation_id: 'changed' } }, consumerA)).results[0].result,
      'recorded',
      'retry correlation context is excluded from idempotency equivalence'
    );
    assert.equal(
      (await sync({ ...firstRequest, ext: { trace: 'changed' } }, consumerA)).results[0].result,
      'failed',
      'changed extension semantics conflict with an existing idempotency key'
    );
    assert.equal(
      (await sync({ ...firstRequest, idempotency_key: 'fixture-status-batch-0002' }, consumerA)).results[0].result,
      'unchanged',
      'an immutable status retry takes precedence over expired provenance validation'
    );

    const fork = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-batch-fork',
        statuses: [{ ...baseWithoutSnapshot, reporting_status_id: 'fixture-status-a-fork' }],
      },
      consumerA
    );
    assert.equal(fork.results[0].result, 'failed');

    const unrelatedSnapshot = await status(
      {
        account: request.account,
        view: 'periods',
        delivery_config_ids: ['fixture-unrelated-config'],
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    const unrelatedProvenance = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-unrelated-snapshot',
        statuses: [
          {
            ...baseWithoutSnapshot,
            reporting_status_id: 'fixture-status-unrelated-01',
            seller_ledger_snapshot_id: unrelatedSnapshot.ledger_snapshot_id,
            seller_ledger_as_of: unrelatedSnapshot.ledger_as_of,
          },
        ],
      },
      consumerA
    );
    assert.equal(unrelatedProvenance.results[0].result, 'failed');

    const filteredConfigurationId = 'fixture-status-filtered-configuration';
    await reference.store.putConfiguration({
      ...configuration,
      configurationId: filteredConfigurationId,
      delivery_config_id: 'fixture-status-filtered-delivery',
      delivery_config_version: 1,
      feedPurpose: 'billing',
      mediaBuyIds: ['fixture-status-filtered-media-buy'],
      installedAt: new Date().toISOString(),
      semanticFingerprint: 'fixture-status-filtered-semantic-fingerprint',
    });
    try {
      for (const [filterName, filter] of [
        ['feed-purpose', { feed_purposes: ['billing'] }],
        ['media-buy', { media_buy_ids: ['fixture-status-filtered-media-buy'] }],
      ]) {
        const consumerId = `fixture-consumer-filtered-${filterName}`;
        const filteredConsumer = {
          account: { account_id: request.account.account_id },
          consumer: consumerId,
        };
        const filteredSnapshot = await reference.store.createSnapshot({
          account_id: request.account.account_id,
          consumer_id: consumerId,
          view: 'periods',
          period: { start: obligation.period.start, end: obligation.period.end },
          ...filter,
        });
        const filteredProvenance = await sync(
          {
            ...firstRequest,
            idempotency_key: `fixture-status-filtered-${filterName}`,
            statuses: [
              {
                ...baseWithoutSnapshot,
                reporting_status_id: `fixture-status-filtered-${filterName}`,
                seller_ledger_snapshot_id: filteredSnapshot.snapshotId,
                seller_ledger_as_of: filteredSnapshot.ledgerAsOf,
              },
            ],
          },
          filteredConsumer
        );
        assert.equal(
          filteredProvenance.results[0].result,
          'failed',
          `${filterName} snapshot provenance cannot authorize an excluded configuration`
        );
      }
    } finally {
      await pool.query('DELETE FROM adcp_reporting_configurations WHERE configuration_id = $1', [
        filteredConfigurationId,
      ]);
    }

    const foreignId = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-batch-b001',
        statuses: [{ ...baseWithoutSnapshot, reporting_status_id: 'fixture-status-a-0001' }],
      },
      consumerB
    );
    assert.equal(foreignId.results[0].result, 'recorded', 'status IDs are scoped by authenticated consumer');
    await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-batch-b002',
        statuses: [{ ...baseWithoutSnapshot, reporting_status_id: 'fixture-status-b-0001' }],
      },
      consumerB
    );

    const beforeRestatement = await status(
      {
        account: request.account,
        view: 'periods',
        health: ['action_required'],
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.ok(beforeRestatement.changes_checkpoint);

    reference.source.restate([{ media_buy_id: request.coverage.mediaBuyIds[0], impressions: 12, spend: '1.20' }]);
    await reference.producer.runWorker({
      now: () => new Date(Date.parse(configuration.schedule.anchor) + 3 * configuration.schedule.periodMilliseconds),
      maxIterations: 1,
    });
    assert.equal((await reference.store.listRevisions(obligation.reporting_obligation_id)).length, 2);
    const periods = await status(
      {
        account: request.account,
        view: 'periods',
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.equal(periods.consumer_statuses.length, 1);
    assert.equal(periods.consumer_statuses[0].reporting_status_id, 'fixture-status-a-0001');
    assert.equal(periods.periods[0].current_consumer_status_id, 'fixture-status-a-0001');
    assert.equal(periods.periods[0].health, 'action_required');
    assert.ok(periods.periods[0].issues.some(issue => issue.code === 'CONSUMER_STATUS_MISMATCH'));
    const filtered = await status(
      {
        account: request.account,
        view: 'periods',
        health: ['action_required'],
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.equal(filtered.periods.length, 1, 'consumer mismatch participates in health filtering');
    const delta = await status(
      {
        account: request.account,
        view: 'periods',
        health: ['action_required'],
        changes_after: beforeRestatement.changes_checkpoint,
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.equal(delta.periods.length, 1, 'delta health projection retains the current consumer status leaf');
    assert.equal(delta.periods[0].current_consumer_status_id, 'fixture-status-a-0001');
    assert.equal(delta.periods[0].consumer_status_count, 1);

    const successor = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-batch-next',
        statuses: [
          {
            reporting_status_id: 'fixture-status-a-0002',
            supersedes_reporting_status_id: 'fixture-status-a-0001',
            delivery_config_id: base.delivery_config_id,
            delivery_config_version: base.delivery_config_version,
            report_definition_id: base.report_definition_id,
            period: base.period,
            reporting_obligation_id: base.reporting_obligation_id,
            consumer_status: 'revision_missing',
            status_as_of: new Date(Date.now() + 1).toISOString(),
          },
          {
            reporting_status_id: 'fixture-status-invalid-01',
            delivery_config_id: 'fixture-unknown-config',
            delivery_config_version: 1,
            report_definition_id: base.report_definition_id,
            period: base.period,
            consumer_status: 'obligation_missing',
            status_as_of: new Date(Date.now() + 1).toISOString(),
          },
        ],
      },
      consumerA
    );
    assert.equal(successor.results[0].result, 'recorded');
    assert.equal(successor.results[1].result, 'failed');
    const successorReadback = await status(
      {
        account: request.account,
        view: 'periods',
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      consumerA
    );
    assert.equal(successorReadback.consumer_statuses.length, 2);
    assert.equal(successorReadback.periods[0].consumer_status_count, 2);
    assert.equal(successorReadback.periods[0].current_consumer_status_id, 'fixture-status-a-0002');

    const stale = await sync(
      {
        ...firstRequest,
        idempotency_key: 'fixture-status-batch-stale',
        statuses: [
          {
            ...baseWithoutSnapshot,
            reporting_status_id: 'fixture-status-a-0003',
            supersedes_reporting_status_id: 'fixture-status-a-0001',
          },
        ],
      },
      consumerA
    );
    assert.equal(stale.results[0].result, 'failed');
  });

  test('accepts an independently derived missing-obligation period', async () => {
    const day = configuration.schedule.periodMilliseconds;
    const start = new Date(Date.parse(configuration.schedule.anchor) + day).toISOString();
    const end = new Date(Date.parse(start) + day).toISOString();
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-a' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
      now: () => new Date(Date.parse(end) + 1),
    });
    const result = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-missing-01',
        statuses: [
          {
            reporting_status_id: 'fixture-status-missing-0001',
            delivery_config_id: configuration.delivery_config_id,
            delivery_config_version: configuration.delivery_config_version,
            report_definition_id: configuration.report_definition_id,
            period: { start, end, source_timezone: configuration.sourceTimezone },
            consumer_status: 'obligation_missing',
            status_as_of: new Date(Date.parse(end) + 1).toISOString(),
          },
        ],
      },
      context
    );
    assert.equal(result.results[0].result, 'recorded');
    const status = ledger.createReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const readback = await status(
      {
        account: request.account,
        view: 'periods',
        period: { start, end },
        pagination: { max_results: 100 },
      },
      context
    );
    assert.equal(readback.scope.coverage_complete, false);
    assert.equal(readback.consumer_statuses[0].reporting_status_id, 'fixture-status-missing-0001');
    assert.ok(readback.issues.some(issue => issue.code === 'HISTORY_UNAVAILABLE'));

    const planned = await reference.producer.planObligations(new Date(Date.parse(end) + 1).toISOString());
    const repairedObligation = planned.find(value => value.period.start === start);
    assert.ok(repairedObligation);
    await reference.producer.runWorker({ now: () => new Date(Date.parse(end) + 1), maxIterations: 4 });
    const [repairedRevision] = await reference.store.listRevisions(repairedObligation.reporting_obligation_id);
    assert.ok(repairedRevision);
    const repaired = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-missing-repaired',
        statuses: [
          {
            reporting_status_id: 'fixture-status-missing-0002',
            supersedes_reporting_status_id: 'fixture-status-missing-0001',
            delivery_config_id: configuration.delivery_config_id,
            delivery_config_version: configuration.delivery_config_version,
            report_definition_id: configuration.report_definition_id,
            period: { start, end, source_timezone: configuration.sourceTimezone },
            reporting_obligation_id: repairedObligation.reporting_obligation_id,
            reporting_revision_id: repairedRevision.reporting_revision_id,
            observed_revision_content_sha256: repairedRevision.wireRevision.revision_content_sha256,
            consumer_status: 'received',
            status_as_of: new Date(Date.parse(end) + 1).toISOString(),
          },
        ],
      },
      context
    );
    assert.equal(repaired.results[0].result, 'recorded');
    const filtered = await status(
      {
        account: request.account,
        view: 'periods',
        health: ['action_required'],
        period: { start, end },
        pagination: { max_results: 100 },
      },
      context
    );
    assert.equal(filtered.periods.length, 0);
    assert.equal(filtered.consumer_statuses.length, 0, 'superseded missing status follows the repaired obligation');
  });

  test('includes a logical missing-obligation status transition in delta periods', async () => {
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-delta' };
    const status = ledger.createReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const query = {
      account: request.account,
      view: 'periods',
      period: { start: obligation.period.start, end: obligation.period.end },
      pagination: { max_results: 100 },
    };
    const checkpoint = await status(query, context);
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const recorded = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-logical-delta',
        statuses: [
          {
            reporting_status_id: 'fixture-status-logical-delta-01',
            delivery_config_id: obligation.delivery_config_id,
            delivery_config_version: obligation.delivery_config_version,
            report_definition_id: obligation.report_definition_id,
            period: {
              start: obligation.period.start,
              end: obligation.period.end,
              source_timezone: obligation.period.sourceTimezone,
            },
            consumer_status: 'obligation_missing',
            status_as_of: new Date().toISOString(),
          },
        ],
      },
      context
    );
    assert.equal(recorded.results[0].result, 'recorded');
    const delta = await status({ ...query, changes_after: checkpoint.changes_checkpoint }, context);
    assert.equal(delta.periods.length, 1);
    assert.equal(delta.consumer_statuses[0].reporting_status_id, 'fixture-status-logical-delta-01');
  });

  test('rejects duplicate status IDs across distinct chains', async () => {
    const day = configuration.schedule.periodMilliseconds;
    const anchor = Date.parse(configuration.schedule.anchor);
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-duplicate' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const duplicate = ordinal => ({
      reporting_status_id: 'fixture-duplicate-status-id',
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: configuration.delivery_config_version,
      report_definition_id: configuration.report_definition_id,
      period: {
        start: new Date(anchor + ordinal * day).toISOString(),
        end: new Date(anchor + (ordinal + 1) * day).toISOString(),
        source_timezone: configuration.sourceTimezone,
      },
      consumer_status: 'obligation_missing',
      status_as_of: new Date().toISOString(),
    });
    const result = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-duplicate-batch',
        statuses: [duplicate(0), duplicate(1)],
      },
      context
    );
    assert.deepEqual(
      result.results.map(value => value.result),
      ['failed', 'failed']
    );
  });

  test('bounds missing-obligation periods to configuration generation ownership', async () => {
    const day = configuration.schedule.periodMilliseconds;
    const anchor = Date.parse(configuration.schedule.anchor);
    const bounded = {
      ...configuration,
      configurationId: 'fixture-bounded-configuration',
      delivery_config_id: 'fixture-bounded-config',
      report_definition_id: 'fixture-bounded-report',
      requiredFinality: 'official',
      schedule: { ...configuration.schedule, officialAfterMilliseconds: 2 * day },
      installedAt: new Date(anchor + 2 * day).toISOString(),
      supersededAt: new Date(anchor + 3 * day).toISOString(),
      semanticFingerprint: 'fixture-bounded-fingerprint',
    };
    await reference.store.putConfiguration(bounded);
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-bounds' };
    const statusAsOf = new Date(anchor + 5 * day).toISOString();
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
      now: () => new Date(anchor + 6 * day),
    });
    const statement = (ordinal, id) => ({
      reporting_status_id: id,
      delivery_config_id: bounded.delivery_config_id,
      delivery_config_version: bounded.delivery_config_version,
      report_definition_id: bounded.report_definition_id,
      period: {
        start: new Date(anchor + ordinal * day).toISOString(),
        end: new Date(anchor + (ordinal + 1) * day).toISOString(),
        source_timezone: bounded.sourceTimezone,
      },
      consumer_status: 'obligation_missing',
      status_as_of: statusAsOf,
    });
    const premature = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-official-too-early',
        statuses: [
          {
            ...statement(2, 'fixture-status-official-early'),
            status_as_of: new Date(anchor + 3 * day + 1).toISOString(),
          },
        ],
      },
      context
    );
    assert.equal(premature.results[0].result, 'failed', 'official absence waits for the declared finality time');
    const response = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-generation-bounds',
        statuses: [
          statement(1, 'fixture-status-before-install'),
          statement(2, 'fixture-status-owned-period'),
          statement(3, 'fixture-status-after-supersede'),
        ],
      },
      context
    );
    assert.deepEqual(
      response.results.map(value => value.result),
      ['failed', 'recorded', 'failed']
    );
  });

  test('preserves sub-millisecond precision for periods and status ordering', async () => {
    const periodConsumer = 'fixture-consumer-instant-period';
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const day = configuration.schedule.periodMilliseconds;
    const alignedStart = new Date(Date.parse(configuration.schedule.anchor) + day).toISOString();
    const alignedEnd = new Date(Date.parse(alignedStart) + day).toISOString();
    const fractional = value => value.replace(/\.\d{3}Z$/, '.0001Z');
    const offBoundary = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-fractional-period',
        statuses: [
          {
            reporting_status_id: 'fixture-status-fractional-period',
            delivery_config_id: configuration.delivery_config_id,
            delivery_config_version: configuration.delivery_config_version,
            report_definition_id: configuration.report_definition_id,
            period: {
              start: fractional(alignedStart),
              end: fractional(alignedEnd),
              source_timezone: configuration.sourceTimezone,
            },
            consumer_status: 'obligation_missing',
            status_as_of: new Date().toISOString(),
          },
        ],
      },
      { account: { account_id: request.account.account_id }, consumer: periodConsumer }
    );
    assert.equal(offBoundary.results[0].result, 'failed', 'fractional drift is not an aligned period');

    const lowercasePeriod = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-lowercase-period',
        statuses: [
          {
            reporting_status_id: 'fixture-status-lowercase-period',
            delivery_config_id: configuration.delivery_config_id,
            delivery_config_version: configuration.delivery_config_version,
            report_definition_id: configuration.report_definition_id,
            period: {
              start: alignedStart.replace('T', 't').replace('Z', 'z'),
              end: alignedEnd.replace('T', 't').replace('Z', 'z'),
              source_timezone: configuration.sourceTimezone,
            },
            consumer_status: 'obligation_missing',
            status_as_of: new Date().toISOString().replace('Z', 'z'),
          },
        ],
      },
      { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-lowercase-period' }
    );
    assert.equal(lowercasePeriod.results[0].result, 'recorded', 'RFC 3339 lowercase t and z remain valid');

    const orderingConsumer = 'fixture-consumer-instant-ordering';
    const second = new Date(Date.now() - 1_000).toISOString().replace(/\.\d{3}Z$/, '');
    const root = {
      reporting_status_id: 'fixture-status-fractional-root',
      delivery_config_id: obligation.delivery_config_id,
      delivery_config_version: obligation.delivery_config_version,
      report_definition_id: obligation.report_definition_id,
      period: {
        start: obligation.period.start,
        end: obligation.period.end,
        source_timezone: obligation.period.sourceTimezone,
      },
      reporting_obligation_id: obligation.reporting_obligation_id,
      consumer_status: 'revision_missing',
      status_as_of: `${second}.0009z`,
    };
    const orderingContext = { account: { account_id: request.account.account_id }, consumer: orderingConsumer };
    assert.equal(
      (
        await sync(
          { account: request.account, idempotency_key: 'fixture-fractional-root', statuses: [root] },
          orderingContext
        )
      ).results[0].result,
      'recorded'
    );
    const regressing = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-fractional-regression',
        statuses: [
          {
            ...root,
            reporting_status_id: 'fixture-status-fractional-successor',
            supersedes_reporting_status_id: root.reporting_status_id,
            status_as_of: `${second}.0001Z`,
          },
        ],
      },
      orderingContext
    );
    assert.equal(regressing.results[0].result, 'failed', 'sub-millisecond status time cannot regress');

    const futureBoundary = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const boundarySecond = futureBoundary.toISOString().replace(/\.\d{3}Z$/, '');
    const boundarySync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
      now: () => futureBoundary,
      clockSkewMilliseconds: 0,
    });
    const future = await boundarySync(
      {
        account: request.account,
        idempotency_key: 'fixture-fractional-future-boundary',
        statuses: [
          {
            ...root,
            reporting_status_id: 'fixture-status-fractional-future',
            status_as_of: `${boundarySecond}.0001Z`,
          },
        ],
      },
      { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-instant-future' }
    );
    assert.equal(future.results[0].result, 'failed', 'fractional time beyond the future ceiling is rejected');
  });

  test('bounds malformed request errors', async () => {
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-invalid' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    assert.equal((await sync(null, context)).results.length, 1);
    assert.equal((await sync({ statuses: Array(1_000).fill(null) }, context)).results.length, 1);
    const oversizedTimestamp = `2026-09-01T00:00:00.${'0'.repeat(65_536)}Z`;
    const oversized = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-oversized-timestamp',
        statuses: [
          {
            reporting_status_id: 'fixture-status-oversized-time',
            delivery_config_id: configuration.delivery_config_id,
            delivery_config_version: configuration.delivery_config_version,
            report_definition_id: configuration.report_definition_id,
            period: {
              start: configuration.schedule.anchor,
              end: new Date(
                Date.parse(configuration.schedule.anchor) + configuration.schedule.periodMilliseconds
              ).toISOString(),
              source_timezone: configuration.sourceTimezone,
            },
            consumer_status: 'obligation_missing',
            status_as_of: oversizedTimestamp,
          },
        ],
      },
      context
    );
    assert.equal(oversized.results[0].result, 'failed');
  });

  test('records valid siblings when another batch item is schema-invalid', async () => {
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-partial' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const periodStart = new Date(
      Date.parse(configuration.schedule.anchor) + configuration.schedule.periodMilliseconds
    ).toISOString();
    const periodEnd = new Date(Date.parse(periodStart) + configuration.schedule.periodMilliseconds).toISOString();
    const valid = {
      reporting_status_id: 'fixture-status-partial-valid',
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: configuration.delivery_config_version,
      report_definition_id: configuration.report_definition_id,
      period: {
        start: periodStart,
        end: periodEnd,
        source_timezone: configuration.sourceTimezone,
      },
      consumer_status: 'obligation_missing',
      status_as_of: new Date().toISOString().replace('Z', '456Z'),
    };
    const invalid = {
      ...valid,
      reporting_status_id: 'fixture-status-partial-invalid',
      delivery_config_version: 1.5,
      consumer_status: 'received',
    };
    assert.equal(
      ledger.ReportingConsumerStatusPreviewV1Schema.safeParse({ ...valid, recorded_at: new Date().toISOString() })
        .success,
      false
    );
    assert.equal(
      ledger.ReportingConsumerStatusPreviewV1Schema.safeParse({ ...valid, unexpected: true }).success,
      false
    );
    const result = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-partial-schema-validation',
        statuses: [valid, invalid],
      },
      context
    );
    assert.deepEqual(
      result.results.map(value => value.result),
      ['recorded', 'failed']
    );
    assert.equal(result.results[0].consumer_status.reporting_status_id, valid.reporting_status_id);
    assert.equal(result.results[1].reporting_status_id, invalid.reporting_status_id);

    const dateOnlyBatch = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-partial-date-only',
        statuses: [
          { ...valid, reporting_status_id: 'fixture-status-date-only-sibling' },
          {
            ...valid,
            reporting_status_id: 'fixture-status-date-only-invalid',
            period: { ...valid.period, start: '2026-09-01', end: '2026-09-02' },
          },
        ],
      },
      { ...context, consumer: 'fixture-consumer-partial-date-only' }
    );
    assert.deepEqual(
      dateOnlyBatch.results.map(value => value.result),
      ['recorded', 'failed'],
      'a malformed date-only identity does not abort a valid sibling'
    );

    const duplicateWithMalformed = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-duplicate-malformed',
        statuses: [
          { ...valid, reporting_status_id: 'fixture-status-duplicate-valid' },
          { ...valid, reporting_status_id: 'fixture-status-duplicate-invalid', unexpected: true },
        ],
      },
      context
    );
    assert.deepEqual(
      duplicateWithMalformed.results.map(value => value.result),
      ['failed', 'failed'],
      'a malformed entry with a valid chain identity rejects every duplicate-chain entry'
    );

    const leapContext = {
      account: { account_id: request.account.account_id },
      consumer: 'fixture-consumer-partial-leap',
    };
    const leapSync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const laterStart = new Date(Date.parse(periodStart) + configuration.schedule.periodMilliseconds).toISOString();
    const leapSecond = {
      ...valid,
      reporting_status_id: 'fixture-status-leap-second',
      period: {
        ...valid.period,
        start: laterStart,
        end: new Date(Date.parse(laterStart) + configuration.schedule.periodMilliseconds).toISOString(),
      },
      status_as_of: '2016-12-31T23:59:60Z',
    };
    assert.equal(ledger.ReportingConsumerStatusPreviewV1Schema.safeParse(leapSecond).success, true);
    const leapBatch = await leapSync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-leap-partial',
        statuses: [{ ...valid, reporting_status_id: 'fixture-status-leap-sibling' }, leapSecond],
      },
      leapContext
    );
    assert.deepEqual(
      leapBatch.results.map(value => value.result),
      ['recorded', 'failed'],
      'a leap-second validation failure does not abort a valid sibling'
    );
  });

  test('accepts a resolved buyer-declared natural account key', async () => {
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-natural-key' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const periodStart = new Date(
      Date.parse(configuration.schedule.anchor) + configuration.schedule.periodMilliseconds
    ).toISOString();
    const result = await sync(
      {
        account: {
          brand: { domain: 'advertiser.example' },
          operator: 'operator.example',
        },
        idempotency_key: 'fixture-status-natural-account-key',
        statuses: [
          {
            reporting_status_id: 'fixture-status-natural-key',
            delivery_config_id: configuration.delivery_config_id,
            delivery_config_version: configuration.delivery_config_version,
            report_definition_id: configuration.report_definition_id,
            period: {
              start: periodStart,
              end: new Date(Date.parse(periodStart) + configuration.schedule.periodMilliseconds).toISOString(),
              source_timezone: configuration.sourceTimezone,
            },
            consumer_status: 'obligation_missing',
            status_as_of: new Date().toISOString(),
          },
        ],
      },
      context
    );
    assert.equal(result.results[0].result, 'recorded');
  });

  test('preserves the predecessor consumer-status store API', async () => {
    const legacyStatus = {
      consumerStatusId: 'fixture-legacy-writer-status',
      reporting_revision_id: revision.reporting_revision_id,
      reporting_obligation_id: obligation.reporting_obligation_id,
      status: { acknowledged: true },
      createdAt: new Date().toISOString(),
    };
    const inserted = await reference.store.putConsumerStatus(legacyStatus);
    assert.equal(inserted.inserted, true);
    const replay = await reference.store.putConsumerStatus(legacyStatus);
    assert.equal(replay.inserted, false);
    assert.deepEqual(replay.value, legacyStatus);
    assert.deepEqual(await reference.store.listConsumerStatuses(revision.reporting_revision_id), [legacyStatus]);
  });

  test('bounds mismatch issue IDs for maximum-length consumer status IDs', async () => {
    const context = { account: { account_id: request.account.account_id }, consumer: 'fixture-consumer-long-id' };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const reportingStatusId = `s${'x'.repeat(254)}`;
    const recorded = await sync(
      {
        account: request.account,
        idempotency_key: 'fixture-status-long-id-batch',
        statuses: [
          {
            reporting_status_id: reportingStatusId,
            delivery_config_id: obligation.delivery_config_id,
            delivery_config_version: obligation.delivery_config_version,
            report_definition_id: obligation.report_definition_id,
            period: {
              start: obligation.period.start,
              end: obligation.period.end,
              source_timezone: obligation.period.sourceTimezone,
            },
            reporting_obligation_id: obligation.reporting_obligation_id,
            reporting_revision_id: revision.reporting_revision_id,
            observed_revision_content_sha256: revision.wireRevision.revision_content_sha256,
            consumer_status: 'received',
            status_as_of: new Date().toISOString(),
          },
        ],
      },
      context
    );
    assert.equal(recorded.results[0].result, 'recorded');
    const status = ledger.createReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const readback = await status(
      {
        account: request.account,
        view: 'periods',
        period: { start: obligation.period.start, end: obligation.period.end },
        pagination: { max_results: 100 },
      },
      context
    );
    const mismatch = readback.periods[0].issues.find(issue => issue.code === 'CONSUMER_STATUS_MISMATCH');
    assert.ok(mismatch);
    assert.ok(mismatch.issue_id.length <= 255);
  });

  test('serializes competing successors and concurrent exact batch retries', async () => {
    const consumer = 'fixture-consumer-concurrency';
    const context = { account: { account_id: request.account.account_id }, consumer };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const initial = {
      reporting_status_id: 'fixture-status-concurrent-root',
      delivery_config_id: obligation.delivery_config_id,
      delivery_config_version: obligation.delivery_config_version,
      report_definition_id: obligation.report_definition_id,
      period: {
        start: obligation.period.start,
        end: obligation.period.end,
        source_timezone: obligation.period.sourceTimezone,
      },
      reporting_obligation_id: obligation.reporting_obligation_id,
      consumer_status: 'revision_missing',
      status_as_of: new Date().toISOString(),
    };
    assert.equal(
      (
        await sync(
          {
            account: request.account,
            idempotency_key: 'fixture-concurrent-root-batch',
            statuses: [initial],
          },
          context
        )
      ).results[0].result,
      'recorded'
    );
    const successor = suffix => ({
      ...initial,
      reporting_status_id: `fixture-status-concurrent-${suffix}`,
      supersedes_reporting_status_id: initial.reporting_status_id,
      status_as_of: new Date(Date.now() + 1).toISOString(),
    });
    const competing = await Promise.all(
      ['left', 'right'].map(suffix =>
        sync(
          {
            account: request.account,
            idempotency_key: `fixture-concurrent-successor-${suffix}`,
            statuses: [successor(suffix)],
          },
          context
        )
      )
    );
    assert.deepEqual(competing.map(value => value.results[0].result).sort(), ['failed', 'recorded']);
    const chain = await pool.query(
      `SELECT consumer_status_id, is_current
         FROM adcp_reporting_consumer_statuses
        WHERE account_id = $1 AND consumer_id = $2
          AND chain_key = (SELECT chain_key FROM adcp_reporting_consumer_statuses
                            WHERE account_id = $1 AND consumer_id = $2 AND consumer_status_id = $3)`,
      [request.account.account_id, consumer, initial.reporting_status_id]
    );
    assert.equal(chain.rows.length, 2);
    assert.equal(chain.rows.filter(value => value.is_current).length, 1);

    const periodStart = new Date(
      Date.parse(configuration.schedule.anchor) + configuration.schedule.periodMilliseconds
    ).toISOString();
    const replayRequest = {
      account: request.account,
      idempotency_key: 'fixture-concurrent-exact-replay',
      statuses: [
        {
          reporting_status_id: 'fixture-status-concurrent-replay',
          delivery_config_id: configuration.delivery_config_id,
          delivery_config_version: configuration.delivery_config_version,
          report_definition_id: configuration.report_definition_id,
          period: {
            start: periodStart,
            end: new Date(Date.parse(periodStart) + configuration.schedule.periodMilliseconds).toISOString(),
            source_timezone: configuration.sourceTimezone,
          },
          consumer_status: 'obligation_missing',
          status_as_of: new Date().toISOString(),
        },
      ],
    };
    const replays = await Promise.all(Array.from({ length: 4 }, () => sync(replayRequest, context)));
    assert.ok(replays.every(value => value.results[0].result === 'recorded'));
    const storedReplay = await pool.query(
      `SELECT count(*)::integer AS count
         FROM adcp_reporting_consumer_statuses
        WHERE account_id = $1 AND consumer_id = $2 AND consumer_status_id = $3`,
      [request.account.account_id, consumer, replayRequest.statuses[0].reporting_status_id]
    );
    assert.equal(storedReplay.rows[0].count, 1);
  });

  test('preserves replay and current leaves at durable status capacity', async () => {
    const consumer = 'fixture-consumer-capacity';
    const context = { account: { account_id: request.account.account_id }, consumer };
    const sync = ledger.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: value => value.consumer,
    });
    const root = {
      reporting_status_id: 'fixture-status-capacity-root',
      delivery_config_id: obligation.delivery_config_id,
      delivery_config_version: obligation.delivery_config_version,
      report_definition_id: obligation.report_definition_id,
      period: {
        start: obligation.period.start,
        end: obligation.period.end,
        source_timezone: obligation.period.sourceTimezone,
      },
      reporting_obligation_id: obligation.reporting_obligation_id,
      reporting_revision_id: revision.reporting_revision_id,
      observed_revision_content_sha256: revision.wireRevision.revision_content_sha256,
      consumer_status: 'received',
      status_as_of: new Date().toISOString(),
    };
    const rootRequest = {
      account: request.account,
      idempotency_key: 'fixture-capacity-root-batch',
      statuses: [root],
    };
    assert.equal((await sync(rootRequest, context)).results[0].result, 'recorded');
    try {
      await pool.query(
        `INSERT INTO adcp_reporting_consumer_status_batches
           (account_id, consumer_id, idempotency_key, request_fingerprint, status_ids, results)
         SELECT $1, $2, 'fixture-capacity-batch-' || value, 'fixture-fingerprint-' || value, '[]'::jsonb, '[]'::jsonb
           FROM generate_series(1, 9999) AS value`,
        [request.account.account_id, consumer]
      );
      await pool.query(
        `INSERT INTO adcp_reporting_consumer_statuses
           (account_id, consumer_id, consumer_status_id, chain_key, revision_id, obligation_id,
            supersedes_consumer_status_id, is_current, semantic_fingerprint, data, created_at, recorded_at)
         SELECT $1, $2, 'fixture-capacity-status-' || value, 'fixture-capacity-chain-' || value,
                NULL, NULL, NULL, false, 'fixture-fingerprint-' || value,
                jsonb_build_object('reporting_status_id', 'fixture-capacity-status-' || value),
                clock_timestamp(), clock_timestamp()
           FROM generate_series(1, 99999) AS value`,
        [request.account.account_id, consumer]
      );

      assert.equal(
        (await sync(rootRequest, context)).results[0].result,
        'recorded',
        'exact batch replay wins at capacity'
      );
      const secondStart = new Date(
        Date.parse(configuration.schedule.anchor) + configuration.schedule.periodMilliseconds
      ).toISOString();
      const mixed = await sync(
        {
          account: request.account,
          idempotency_key: 'fixture-capacity-mixed-batch',
          statuses: [
            root,
            {
              reporting_status_id: 'fixture-status-capacity-new',
              delivery_config_id: configuration.delivery_config_id,
              delivery_config_version: configuration.delivery_config_version,
              report_definition_id: configuration.report_definition_id,
              period: {
                start: secondStart,
                end: new Date(Date.parse(secondStart) + configuration.schedule.periodMilliseconds).toISOString(),
                source_timezone: configuration.sourceTimezone,
              },
              consumer_status: 'obligation_missing',
              status_as_of: new Date().toISOString(),
            },
          ],
        },
        context
      );
      assert.deepEqual(
        mixed.results.map(value => value.result),
        ['unchanged', 'failed']
      );
      assert.equal(mixed.results[1].errors[0].code, 'RESOURCE_EXHAUSTED');
      const leaves = await pool.query(
        `SELECT consumer_status_id FROM adcp_reporting_consumer_statuses
          WHERE account_id = $1 AND consumer_id = $2 AND is_current`,
        [request.account.account_id, consumer]
      );
      assert.deepEqual(
        leaves.rows.map(value => value.consumer_status_id),
        [root.reporting_status_id]
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::integer AS count FROM adcp_reporting_consumer_statuses
              WHERE account_id = $1 AND consumer_id = $2 AND consumer_status_id = 'fixture-status-capacity-new'`,
            [request.account.account_id, consumer]
          )
        ).rows[0].count,
        0
      );
    } finally {
      await pool.query(
        'DELETE FROM adcp_reporting_consumer_status_batches WHERE account_id = $1 AND consumer_id = $2',
        [request.account.account_id, consumer]
      );
      await pool.query('DELETE FROM adcp_reporting_consumer_statuses WHERE account_id = $1 AND consumer_id = $2', [
        request.account.account_id,
        consumer,
      ]);
    }
  });

  test('preserves populated predecessor rows during migration', async () => {
    await pool.query(
      'ALTER TABLE adcp_reporting_consumer_statuses DROP CONSTRAINT adcp_reporting_consumer_statuses_pkey'
    );
    await pool.query('ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN account_id DROP NOT NULL');
    await pool.query('ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN consumer_id DROP NOT NULL');
    await pool.query('ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN chain_key DROP NOT NULL');
    await pool.query('ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN semantic_fingerprint DROP NOT NULL');
    await pool.query(
      `INSERT INTO adcp_reporting_consumer_statuses
       (account_id, consumer_id, consumer_status_id, chain_key, revision_id, obligation_id,
        is_current, semantic_fingerprint, data, created_at)
       VALUES (NULL, NULL, 'fixture-legacy-status-0001', NULL, $1, $2, true, NULL, $3::jsonb, clock_timestamp())`,
      [
        revision.reporting_revision_id,
        obligation.reporting_obligation_id,
        JSON.stringify({ reporting_status_id: 'fixture-legacy-status-0001' }),
      ]
    );
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    const migrated = await pool.query(
      `SELECT account_id, consumer_id, chain_key, semantic_fingerprint
       FROM adcp_reporting_consumer_statuses WHERE consumer_status_id = 'fixture-legacy-status-0001'`
    );
    assert.equal(migrated.rows[0].account_id, request.account.account_id);
    assert.equal(migrated.rows[0].consumer_id, '__legacy_unscoped_consumer__');
    assert.equal(migrated.rows[0].chain_key, 'legacy:fixture-legacy-status-0001');
    assert.equal(migrated.rows[0].semantic_fingerprint, 'legacy:fixture-legacy-status-0001');
  });
});
