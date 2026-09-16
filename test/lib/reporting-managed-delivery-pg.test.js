/**
 * PostgreSQL crash/race coverage for seller Managed Delivery and Reconciled Billing.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-managed-delivery-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('PostgresReportingManagedDeliveryStore', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_managed_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let core;
  let managed;
  let fixture;
  let canonicalize;
  let validateResponse;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    canonicalize = require('../../dist/lib/utils/jcs.js').canonicalize;
    validateResponse = require('../../dist/lib/validation/schema-validator.js').validateResponse;
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    core = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
    });
    managed = new ledger.PostgresReportingManagedDeliveryStore(pool);
    fixture = await seedCoreLedger();
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('requires an explicit same-authority Core opt-in before advertising capabilities', async () => {
    assert.deepEqual(await managed.installBinding(fixture.binding), { inserted: false });
    const pendingReceipt = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(pendingReceipt.periods[0].health, 'action_required');
    assert.equal(
      pendingReceipt.periods[0].issues.some(value => value.code === 'RECEIPT_REQUIRED'),
      true
    );
    const coreOnly = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          coreStore: coreOnly,
          store: managed,
          adapter: {
            verificationProfiles: ['canonical_digest'],
            revocationFencesDeliveryGenerations: true,
            deliver: async () => materializationOutcome(fixture),
            read: async () => Buffer.alloc(0),
            revoke: async () => {},
          },
          offerings: [deliveryOffering()],
          automatedRecoveryWindowSeconds: 60,
          statusRetentionDays: 90,
          resourceRetentionDays: 30,
          authorizationRevocationSeconds: 60,
        }),
      /managedDelivery: true/
    );
  });

  test('refuses a first managed binding after a Core obligation is observable', async () => {
    const accountId = 'account-late-binding';
    const configuration = {
      ...fixture.configuration,
      configurationId: 'configuration-late-binding-1',
      account: { account_id: accountId },
      delivery_config_id: 'late-binding-files',
      offeringId: 'late-binding-files-v1',
      semanticFingerprint: 'configuration-late-binding-fingerprint',
    };
    await core.putConfiguration(configuration);
    await core.putObligation({
      ...fixture.obligation,
      reporting_obligation_id: 'obligation-late-binding-1',
      configurationId: configuration.configurationId,
      account: configuration.account,
      delivery_config_id: configuration.delivery_config_id,
      offeringId: configuration.offeringId,
      semanticFingerprint: 'obligation-late-binding-fingerprint',
    });
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-late-binding-1',
      generation: 1,
      authorized_at: fixture.now,
    });
    await assert.rejects(
      () =>
        managed.installBinding(
          ledger.reportingManagedDeliveryBindingV1({
            ...fixture.binding,
            configurationId: configuration.configurationId,
            account_id: accountId,
            delivery_config_id: configuration.delivery_config_id,
            destination_ref: 'destination-late-binding-1',
          })
        ),
      /PostgresReportingManagedDeliveryStore transaction failed/
    );
  });

  test('leases one worker, retries after a crash, and retains exact verified resources', async () => {
    let attempts = 0;
    let deliveryStarted;
    let releaseFirstDelivery;
    const started = new Promise(resolve => {
      deliveryStarted = resolve;
    });
    const firstDeliveryGate = new Promise(resolve => {
      releaseFirstDelivery = resolve;
    });
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) {
          deliveryStarted();
          await firstDeliveryGate;
          throw new Error('simulated process boundary');
        }
        return materializationOutcome(fixture);
      },
      read: async () => Buffer.from('exact retained bytes'),
      revoke: async () => {},
    };
    await managed.planMaterializations();
    const firstWorker = ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(fixture.now),
      maxIterations: 1,
    });
    await started;
    const secondWorker = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(fixture.now),
      maxIterations: 1,
    });
    releaseFirstDelivery();
    const concurrent = [await firstWorker, secondWorker];
    assert.equal(
      concurrent.reduce((sum, value) => sum + value.failed, 0),
      1
    );
    assert.equal(
      concurrent.reduce((sum, value) => sum + value.delivered, 0),
      0
    );
    assert.equal(attempts, 1, 'SKIP LOCKED exposes the pending attempt to only one worker');
    const second = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(fixture.now) + 1000),
      maxIterations: 2,
    });
    assert.equal(second.delivered, 1);
    assert.equal(attempts, 2);

    const rows = await pool.query(`SELECT attempt, status, data FROM adcp_reporting_materializations ORDER BY attempt`);
    assert.deepEqual(
      rows.rows.map(row => [row.attempt, row.status]),
      [
        [1, 'failed'],
        [2, 'available'],
      ]
    );
    fixture.materialization = rows.rows[1].data;
    const bytes = await ledger.readManagedReportingResource(managed, adapter, {
      account_id: fixture.accountId,
      resource_ref: fixture.materialization.resource.resource_ref,
    });
    assert.equal(Buffer.from(bytes).toString(), 'exact retained bytes');
  });

  test('projects RC3 receipt-required state, append-only repair, and exact replay', async () => {
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: context => context.agent.agent_url,
    });
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } };
    const beforeReceipt = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    assert.equal(beforeReceipt.periods[0].reconciliation_status, 'pending');
    assert.equal(beforeReceipt.periods[0].health, 'action_required');
    assert.equal(beforeReceipt.periods[0].issues.at(-1).code, 'RECEIPT_REQUIRED');
    const filteredOut = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'periods',
        period: fixture.period,
        health: ['complete'],
      },
      context
    );
    assert.equal(filteredOut.periods.length, 0);
    assert.equal(filteredOut.pagination.total_count, 0);
    assert.equal(filteredOut.pagination.has_more, false);
    assert.equal(beforeReceipt.materializations.length, 2, 'failed attempts remain immutable history');
    assert.equal(
      validateResponse('get_reporting_status', beforeReceipt, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', beforeReceipt, '3.2.0-rc.3').issues)
    );

    const syncReceipts = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => new Date(Date.parse(fixture.now) + 2000)
    );
    const rejected = receipt(fixture, {
      reporting_receipt_id: 'receipt-rejected-0001',
      status: 'rejected',
      observed_row_count: 3,
      rejection_codes: ['ROW_COUNT_MISMATCH'],
    });
    const rejectedResult = await syncReceipts(
      { idempotency_key: 'receipt-batch-rejected-0001', receipts: [rejected] },
      context
    );
    assert.equal(rejectedResult.results[0].result, 'recorded');
    assert.equal(validateResponse('sync_reporting_receipts', rejectedResult, '3.2.0-rc.3').valid, true);

    const accepted = receipt(fixture, {
      reporting_receipt_id: 'receipt-accepted-0001',
      supersedes_reporting_receipt_id: rejected.reporting_receipt_id,
      status: 'accepted',
    });
    const acceptedRequest = { idempotency_key: 'receipt-batch-accepted-0001', receipts: [accepted] };
    const acceptedResult = await syncReceipts(acceptedRequest, context);
    assert.equal(acceptedResult.results[0].result, 'recorded');
    const replay = await syncReceipts(acceptedRequest, context);
    assert.deepEqual(replay, acceptedResult, 'same batch key replays the original result');
    const conflict = await syncReceipts(
      {
        ...acceptedRequest,
        receipts: [{ ...accepted, observed_at: new Date(Date.parse(fixture.now) + 3000).toISOString() }],
      },
      context
    );
    assert.equal(conflict.results[0].errors[0].code, 'IDEMPOTENCY_CONFLICT');
    const unchanged = await syncReceipts(
      { idempotency_key: 'receipt-batch-accepted-0002', receipts: [accepted] },
      context
    );
    assert.equal(unchanged.results[0].result, 'unchanged');

    const acceptedStatus = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    assert.equal(acceptedStatus.periods[0].reconciliation_status, 'accepted');
    assert.equal(acceptedStatus.periods[0].health, 'complete');
    assert.equal(acceptedStatus.periods[0].receipt_count, 2);
    assert.equal(validateResponse('get_reporting_status', acceptedStatus, '3.2.0-rc.3').valid, true);

    const pagedReceipts = [];
    let cursor;
    do {
      const page = await getStatus(
        {
          account: { account_id: fixture.accountId },
          view: 'periods',
          period: fixture.period,
          pagination: { max_results: 1, ...(cursor ? { cursor } : {}) },
        },
        context
      );
      assert.equal(
        validateResponse('get_reporting_status', page, '3.2.0-rc.3').valid,
        true,
        JSON.stringify(validateResponse('get_reporting_status', page, '3.2.0-rc.3').issues)
      );
      pagedReceipts.push(...page.receipts);
      cursor = page.pagination.cursor;
    } while (cursor);
    assert.deepEqual(
      pagedReceipts.map(value => value.reporting_receipt_id),
      ['receipt-rejected-0001', 'receipt-accepted-0001']
    );

    const terminal = await syncReceipts(
      {
        idempotency_key: 'receipt-batch-terminal-0001',
        receipts: [
          receipt(fixture, {
            reporting_receipt_id: 'receipt-terminal-0001',
            supersedes_reporting_receipt_id: accepted.reporting_receipt_id,
            status: 'accepted',
          }),
        ],
      },
      context
    );
    assert.equal(terminal.results[0].result, 'failed');

    const foreign = await syncReceipts(
      {
        idempotency_key: 'receipt-batch-foreign-0001',
        receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-foreign-0001' })],
      },
      { ...context, account: { id: 'account-foreign' } }
    );
    assert.equal(foreign.results[0].result, 'failed');
    assert.equal(foreign.results[0].errors[0].message, terminal.results[0].errors[0].message);
  });

  test('serializes competing accepted receipts and exposes only caller-scoped history', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-two.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const [left, right] = await Promise.all([
      sync(
        {
          idempotency_key: 'receipt-concurrent-left-0001',
          receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-concurrent-left-0001' })],
        },
        context
      ),
      sync(
        {
          idempotency_key: 'receipt-concurrent-right-0001',
          receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-concurrent-right-0001' })],
        },
        context
      ),
    ]);
    assert.deepEqual([left.results[0].result, right.results[0].result].sort(), ['failed', 'recorded']);
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'revision',
        reporting_revision_id: fixture.revision.reporting_revision_id,
      },
      context
    );
    assert.equal(status.receipts.length, 1);
    assert.ok(status.receipts[0].reporting_receipt_id.startsWith('receipt-concurrent-'));
  });

  test('keeps official evidence immutable and reconciles append-only adjustments from a checkpoint', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } };
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const baseline = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    const rows = [];
    const rowBytes = Buffer.from(canonicalize(rows));
    const adjustment = {
      reporting_adjustment_id: 'adjustment-invalid-traffic-0001',
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
      adjustmentNumber: 1,
      manifest: { level: 'basic', objectRef: 'adjustment-manifest', sha256: 'd'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'adjustment-publication-1',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(rowBytes).digest('hex'),
        byteCount: rowBytes.byteLength,
        rowCount: 0,
      },
      rows,
      observedAt: fixture.now,
      dataThrough: fixture.period.end,
      sourceReadCutoffAt: fixture.now,
      createdAt: fixture.now,
      wireAdjustment: {
        reporting_adjustment_id: 'adjustment-invalid-traffic-0001',
        adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
        reason_code: 'invalid_traffic',
        accounting_period: fixture.period,
        control_total_deltas: [{ name: 'impressions', value: '-5', value_type: 'integer', unit: 'impressions' }],
        canonical_adjustment_sha256: 'e'.repeat(64),
        correction_observed_at: fixture.now,
        created_at: fixture.now,
      },
    };
    await core.commitAdjustment(adjustment, fixture.coreLease);
    const reopened = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'periods',
        period: fixture.period,
        changes_after: baseline.changes_checkpoint,
      },
      context
    );
    assert.equal(reopened.periods[0].reconciliation_status, 'pending');
    assert.equal(reopened.periods[0].issues.at(-1).code, 'ADJUSTMENT_RECEIPT_REQUIRED');
    assert.equal(reopened.adjustments.length, 1);
    assert.equal(reopened.revisions[0].reporting_revision_id, fixture.revision.reporting_revision_id);
    assert.equal(
      validateResponse('get_reporting_status', reopened, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', reopened, '3.2.0-rc.3').issues)
    );

    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const adjustmentResult = await sync(
      {
        idempotency_key: 'adjustment-receipt-batch-0001',
        adjustment_receipts: [
          {
            reporting_receipt_id: 'adjustment-receipt-accepted-0001',
            reporting_adjustment_id: adjustment.reporting_adjustment_id,
            adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
            status: 'accepted',
            observed_adjustment_sha256: adjustment.wireAdjustment.canonical_adjustment_sha256,
            observed_at: fixture.now,
          },
        ],
      },
      context
    );
    assert.equal(adjustmentResult.results[0].result, 'recorded');
    assert.equal(
      (await core.getRevision(fixture.revision.reporting_revision_id, fixture.accountId)).finality,
      'official'
    );
  });

  test('keeps a receipt commit concurrent with a snapshot visible after its checkpoint', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-three.example' } };
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const baseline = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    await pool.query(`
      CREATE FUNCTION delay_managed_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$;
      CREATE TRIGGER delay_managed_receipt_insert
        BEFORE INSERT ON adcp_reporting_receipts
        FOR EACH ROW EXECUTE FUNCTION delay_managed_receipt_insert()
    `);
    try {
      const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
      const write = sync(
        {
          idempotency_key: 'checkpoint-race-batch-0001',
          receipts: [receipt(fixture, { reporting_receipt_id: 'checkpoint-race-receipt-0001' })],
        },
        context
      );
      await new Promise(resolve => setTimeout(resolve, 25));
      const delta = getStatus(
        {
          account: { account_id: fixture.accountId },
          view: 'periods',
          period: fixture.period,
          changes_after: baseline.changes_checkpoint,
        },
        context
      );
      assert.equal((await write).results[0].result, 'recorded');
      const visible = await delta;
      assert.equal(
        visible.receipts.some(value => value.reporting_receipt_id === 'checkpoint-race-receipt-0001'),
        true
      );
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS delay_managed_receipt_insert ON adcp_reporting_receipts');
      await pool.query('DROP FUNCTION IF EXISTS delay_managed_receipt_insert()');
    }
  });

  test('revocation denies queued work and reads before asynchronous provider cleanup', async () => {
    const revokedAt = new Date(Date.parse(fixture.now) + 3000).toISOString();
    assert.equal(
      await managed.revokeDestination({
        account_id: fixture.accountId,
        destination_ref: fixture.binding.destination_ref,
        generation: fixture.binding.authorization_generation,
        revoked_at: revokedAt,
      }),
      true
    );
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => assert.fail('revoked work must not reach delivery I/O'),
      read: async () => assert.fail('revoked resources must not reach reader I/O'),
      revoke: async () => {},
    };
    assert.equal(
      await ledger.readManagedReportingResource(managed, adapter, {
        account_id: fixture.accountId,
        resource_ref: fixture.materialization.resource.resource_ref,
      }),
      null
    );
    const result = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(revokedAt),
      maxIterations: 2,
    });
    assert.equal(result.revocationsCompleted, 1);
    const revokedStatus = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(revokedStatus.periods[0].health, 'action_required');
    assert.equal(revokedStatus.periods[0].successful_materialization_count, 1);
    assert.equal(
      revokedStatus.materializations.some(value => value.status === 'available'),
      true
    );
    const revokedReplay = await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-batch-accepted-0001',
        receipts: [
          receipt(fixture, {
            reporting_receipt_id: 'receipt-accepted-0001',
            supersedes_reporting_receipt_id: 'receipt-rejected-0001',
            status: 'accepted',
          }),
        ],
      },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(revokedReplay.results[0].result, 'failed');
    const retained = await pool.query(
      'SELECT COUNT(*)::integer AS count FROM adcp_reporting_materializations WHERE account_id = $1',
      [fixture.accountId]
    );
    assert.equal(retained.rows[0].count, 2);
    await managed.authorizeDestination({
      account_id: fixture.accountId,
      destination_ref: fixture.binding.destination_ref,
      generation: 2,
      authorized_at: new Date(Date.parse(revokedAt) + 1000).toISOString(),
    });
    assert.equal(
      await managed.isAuthorizationCurrent({
        account_id: fixture.accountId,
        destination_ref: fixture.binding.destination_ref,
        generation: 1,
      }),
      false
    );
    assert.equal(
      await managed.isAuthorizationCurrent({
        account_id: fixture.accountId,
        destination_ref: fixture.binding.destination_ref,
        generation: 2,
      }),
      true
    );
    await assert.rejects(
      () =>
        managed.installBinding(
          ledger.reportingManagedDeliveryBindingV1({
            ...fixture.binding,
            authorization_generation: 2,
            created_at: new Date(Date.parse(revokedAt) + 1000).toISOString(),
          })
        ),
      /PostgresReportingManagedDeliveryStore transaction failed/
    );
    const secondRevokedAt = new Date(Date.parse(revokedAt) + 2000).toISOString();
    await managed.revokeDestination({
      account_id: fixture.accountId,
      destination_ref: fixture.binding.destination_ref,
      generation: 2,
      revoked_at: secondRevokedAt,
    });
    const expiredCleanup = await managed.claimRevocation({
      owner: 'stale-cleanup-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 1,
      account_id: fixture.accountId,
    });
    assert.ok(expiredCleanup);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(
      await managed.completeRevocation({ lease: expiredCleanup, completed_at: new Date().toISOString() }),
      false
    );
  });

  async function seedCoreLedger() {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 3_600_000).toISOString(),
      end: new Date(nowMs - 1_800_000).toISOString(),
    };
    const accountId = 'account-managed';
    const configuration = {
      configurationId: 'configuration-managed-1',
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: 'billing-files',
      delivery_config_version: 1,
      offeringId: 'billing-files-v1',
      report_definition_id: 'billing-v1',
      feedPurpose: 'billing',
      requiredFinality: 'official',
      canonicalization: {
        id: 'billing-rows-v1',
        uri: 'https://schemas.fixture.example/canonicalization.json',
        sha256: 'c'.repeat(64),
        primaryKeys: ['media_buy_id'],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-1'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: period.start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'billing-v1' },
      installedAt: period.start,
      semanticFingerprint: 'configuration-managed-fingerprint',
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-generation-1',
      generation: 1,
      authorized_at: now,
    });
    const binding = ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: 'destination-generation-1',
      authorization_generation: 1,
      feed_purpose: 'billing',
      method: 'file_transfer',
      transport: 'fixture_object_store',
      verification_profile: 'canonical_digest',
      reconciliation_mode: 'consumer_receipt',
      resource_retention_days: 30,
      created_at: now,
    });
    await managed.installBinding(binding);
    const obligation = {
      reporting_obligation_id: 'obligation-managed-1',
      configurationId: configuration.configurationId,
      account: configuration.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: configuration.offeringId,
      report_definition_id: configuration.report_definition_id,
      feedPurpose: 'billing',
      requiredFinality: 'official',
      periodOrdinal: 0,
      period: { ...period, sourceTimezone: 'UTC' },
      schedule: configuration.schedule,
      scopeResolvedAt: period.end,
      coverage: {
        status: 'full',
        evaluatedAt: period.end,
        mediaBuyIds: ['buy-1'],
        fullyCoveredMediaBuyIds: ['buy-1'],
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-1'],
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: period.end,
      recoveryDeadlineAt: new Date(Date.parse(period.end) + 60_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: 'obligation-managed-fingerprint',
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({ owner: 'core-worker', now, leaseMilliseconds: 600_000 });
    const rows = [{ media_buy_id: 'buy-1', impressions: 5 }];
    const controlTotals = [{ name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' }];
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: 'revision-managed-official-1',
        row_count: rows.length,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const digest = {
      algorithm: 'sha256',
      value: 'b'.repeat(64),
      canonicalization_id: 'billing-rows-v1',
      canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
      canonicalization_sha256: 'c'.repeat(64),
    };
    const revision = {
      reporting_revision_id: 'revision-managed-official-1',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'publication-managed-1',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        byteCount: revisionBytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: now,
      dataThrough: period.end,
      sourceReadCutoffAt: now,
      createdAt: now,
      wireRevision: {
        reporting_revision_id: 'revision-managed-official-1',
        revision_content_sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        report_definition_id: 'billing-v1',
        report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
        report_definition_sha256: '9'.repeat(64),
        reporting_profile: 'billing-v1',
        schema_version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: '8'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        account_id: accountId,
        media_buy_ids: ['buy-1'],
        coverage: {
          status: 'full',
          evaluated_at: now,
          media_buy_ids: ['buy-1'],
          fully_covered_media_buy_ids: ['buy-1'],
          partially_covered_media_buy_ids: [],
          unsupported_media_buy_ids: [],
          unknown_media_buy_ids: [],
          package_ids: [],
          covered_package_ids: [],
          unsupported_package_ids: [],
          unknown_package_ids: [],
          limitations: [],
        },
        period: { ...period, source_timezone: 'UTC' },
        finality: 'official',
        finality_basis: 'contractual_cutoff',
        finality_policy_id: 'contractual-cutoff-v1',
        finalized_at: now,
        observed_at: now,
        data_through: period.end,
        data_through_precision: 'exact',
        row_count: 1,
        control_totals: controlTotals,
        canonical_content_digest: digest,
        created_at: now,
      },
    };
    await core.commitRevision(revision, coreLease);
    return { accountId, now, period, configuration, obligation, revision, binding, coreLease };
  }
});

function materializationOutcome(fixture) {
  return {
    status: 'available',
    resource: {
      resource_ref: 'resource-managed-1',
      kind: 'manifest',
      location: 'reports/revision-managed-official-1/manifest.json',
      manifest_version: '1.0',
      manifest_sha256: 'f'.repeat(64),
      immutability: 'immutable_location',
      expires_at: new Date(Date.parse(fixture.now) + 31 * 86_400_000).toISOString(),
    },
    verification: {
      verified_at: fixture.now,
      verification_path: 'representative_consumer',
      verification_profile: 'canonical_digest',
      row_count: 1,
      control_totals: fixture.revision.wireRevision.control_totals,
      physical_checksums: [{ object_ref: 'rows.json', algorithm: 'sha256', value: '7'.repeat(64) }],
      canonical_content_digest: fixture.revision.wireRevision.canonical_content_digest,
    },
  };
}

function receipt(fixture, overrides = {}) {
  return {
    reporting_receipt_id: 'receipt-accepted-default-0001',
    reporting_obligation_id: fixture.obligation.reporting_obligation_id,
    reporting_revision_id: fixture.revision.reporting_revision_id,
    reporting_materialization_id: fixture.materialization.reporting_materialization_id,
    status: 'accepted',
    verification_profile: 'canonical_digest',
    observed_row_count: 1,
    observed_control_totals: fixture.revision.wireRevision.control_totals,
    observed_canonical_content_digest: fixture.revision.wireRevision.canonical_content_digest,
    observed_manifest_sha256: fixture.materialization.resource.manifest_sha256,
    observed_at: fixture.now,
    ...overrides,
  };
}

function deliveryOffering() {
  return {
    offering_id: 'managed-file-transfer-v1',
    feed_purpose: 'analytics',
    report_definition_id: 'billing-v1',
    report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
    report_definition_sha256: 'd'.repeat(64),
    reporting_profile: {
      id: 'billing-v1',
      version: '1.0',
      schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
      schema_sha256: 'e'.repeat(64),
      schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
      schema_ref_policy: 'local_fragment_only',
      grain: 'media_buy/day',
      primary_keys: ['media_buy_id'],
      metrics: [{ name: 'impressions', value_type: 'integer' }],
      dimensions: [{ name: 'media_buy_id', value_type: 'string' }],
    },
    schedule: { period_duration: 'PT30M', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['official'],
    reconciliation_mode: 'delivery_only',
    method: {
      pattern: 'file_transfer',
      transport: 'fixture_object_store',
      orchestration: 'producer_managed',
      destination_modes: ['existing'],
      provider: { domain: 'fixture.example' },
      format: 'jsonl',
    },
  };
}
