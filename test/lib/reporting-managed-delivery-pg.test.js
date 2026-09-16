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
  let snapshotFixture;
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
    // An exact same-key replay is side-effect free and returns the caller its
    // own prior verdict. Revocation governs what may be newly accepted, not
    // what an already-answered idempotency key answers, and the body is the
    // caller's own receipt echoed back — no other consumer's state is read.
    assert.equal(revokedReplay.results[0].result, 'recorded');
    assert.equal(revokedReplay.results[0].receipt.reporting_receipt_id, 'receipt-accepted-0001');
    assert.equal(validateResponse('sync_reporting_receipts', revokedReplay, '3.2.0-rc.3').valid, true);
    // A new receipt under a fresh key is still refused while revoked.
    const revokedFresh = await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-batch-after-revoke-0001',
        receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-after-revoke-0001' })],
      },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(revokedFresh.results[0].result, 'failed', 'fail-closed still governs newly accepted evidence');
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

  test('accepts a receipt for a snapshot-finality obligation its own contract requires', async () => {
    const snapshot = await seedSnapshotFinalityLedger();
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(snapshot),
      read: async () => Buffer.from('snapshot bytes'),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: snapshot.accountId });
    const worker = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(snapshot.now) + 1000),
      maxIterations: 2,
      account_id: snapshot.accountId,
    });
    assert.equal(worker.delivered, 1, 'a snapshot revision is materializable');
    const stored = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [snapshot.obligation.reporting_obligation_id]
    );
    snapshot.materialization = stored.rows[0].data;

    const context = { account: { id: snapshot.accountId }, agent: { agent_url: 'https://snapshot-buyer.example' } };
    const syncReceipts = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => new Date(Date.parse(snapshot.now) + 2000)
    );
    const acceptedRequest = {
      idempotency_key: 'receipt-snapshot-finality-0001',
      receipts: [receipt(snapshot, { reporting_receipt_id: 'receipt-snapshot-accepted-0001' })],
    };
    const accepted = await syncReceipts(acceptedRequest, context);
    assert.equal(
      accepted.results[0].result,
      'recorded',
      'hard-coding official finality made every snapshot-finality contract unreconcilable'
    );
    assert.equal(validateResponse('sync_reporting_receipts', accepted, '3.2.0-rc.3').valid, true);

    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      { account: { account_id: snapshot.accountId }, view: 'periods', period: snapshot.period },
      context
    );
    assert.equal(status.periods[0].reconciliation_status, 'accepted');
    assert.equal(
      validateResponse('get_reporting_status', status, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', status, '3.2.0-rc.3').issues)
    );
    snapshotFixture = { ...snapshot, acceptedRequest, acceptedResult: accepted };
  });

  test('keeps the receipt replay cache compact and replays a pre-upgrade row', async () => {
    const snapshot = snapshotFixture;
    const context = { account: { id: snapshot.accountId }, agent: { agent_url: 'https://snapshot-buyer.example' } };
    const syncReceipts = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => new Date(Date.parse(snapshot.now) + 3000)
    );
    const cached = await pool.query(`SELECT results FROM adcp_reporting_receipt_batches WHERE idempotency_key = $1`, [
      snapshot.acceptedRequest.idempotency_key,
    ]);
    const stored = cached.rows[0].results;
    assert.deepEqual(
      stored.map(value => value.kind),
      ['recorded'],
      'the replay row keeps a verdict, not a second copy of the receipt'
    );
    assert.equal(stored[0].receipt, undefined, 'receipt bodies are not duplicated into the replay cache');
    assert.ok(
      Buffer.byteLength(JSON.stringify(stored), 'utf8') < 512,
      'a compact replay row cannot grow with receipt size'
    );

    const replay = await syncReceipts(snapshot.acceptedRequest, context);
    assert.deepEqual(replay, snapshot.acceptedResult, 'replay is still byte-identical to the original response');

    // A key written by the previous build stored the whole response entry.
    await pool.query(`UPDATE adcp_reporting_receipt_batches SET results = $2::jsonb WHERE idempotency_key = $1`, [
      snapshot.acceptedRequest.idempotency_key,
      JSON.stringify(snapshot.acceptedResult.results),
    ]);
    const legacyReplay = await syncReceipts(snapshot.acceptedRequest, context);
    assert.deepEqual(
      legacyReplay,
      snapshot.acceptedResult,
      'an idempotency key in flight across the upgrade still replays'
    );

    // Retention ages the cache out, so reaching the per-consumer cap throttles
    // a burst instead of locking the consumer out permanently.
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE idempotency_key = $1`,
      [snapshot.acceptedRequest.idempotency_key]
    );
    const fresh = await syncReceipts(
      {
        idempotency_key: 'receipt-compact-cache-0002',
        receipts: [receipt(snapshot, { reporting_receipt_id: 'receipt-compact-cache-0002' })],
      },
      context
    );
    assert.equal(validateResponse('sync_reporting_receipts', fresh, '3.2.0-rc.3').valid, true);
    const remaining = await pool.query(`SELECT 1 FROM adcp_reporting_receipt_batches WHERE idempotency_key = $1`, [
      snapshot.acceptedRequest.idempotency_key,
    ]);
    assert.equal(remaining.rowCount, 0, 'expired replay rows are pruned for this caller only');
    const others = await pool.query(
      `SELECT 1 FROM adcp_reporting_receipt_batches WHERE consumer_id <> 'https://snapshot-buyer.example'`
    );
    assert.ok(others.rowCount > 0, 'another consumer replay cache is untouched');
  });

  test('replays a revision and adjustment stored before the canonical digests existed', async () => {
    const storedRevision = await pool.query(
      `UPDATE adcp_reporting_revisions
          SET data = jsonb_set(data, '{wireRevision}', (data->'wireRevision') - 'canonical_content_digest')
        WHERE revision_id = $1 RETURNING data`,
      [fixture.revision.reporting_revision_id]
    );
    assert.equal(storedRevision.rows[0].data.wireRevision.canonical_content_digest, undefined);
    const replayedRevision = await core.commitRevision(fixture.revision, fixture.coreLease);
    assert.equal(replayedRevision.inserted, false);
    assert.equal(
      replayedRevision.value.wireRevision.canonical_content_digest,
      undefined,
      'the pre-upgrade row is returned unchanged rather than rewritten'
    );
    await assert.rejects(
      () =>
        core.commitRevision(
          { ...fixture.revision, wireRevision: { ...fixture.revision.wireRevision, row_count: 99 } },
          fixture.coreLease
        ),
      /transaction failed/,
      'the tolerance covers the added digest and nothing else'
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions
          SET data = jsonb_set(data, '{wireRevision,canonical_content_digest}', $2::jsonb)
        WHERE revision_id = $1`,
      [fixture.revision.reporting_revision_id, JSON.stringify(fixture.revision.wireRevision.canonical_content_digest)]
    );

    const rows = [{ media_buy_id: 'buy-1', impressions: 7 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-legacy-digest-0001',
      adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: fixture.period.start, end: fixture.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: fixture.now,
      created_at: fixture.now,
    };
    const legacyAdjustment = {
      reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
      adjustmentNumber: 2,
      manifest: { level: 'basic', objectRef: 'legacy-manifest', sha256: 'c'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'adjustment-publication-legacy',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: fixture.now,
      dataThrough: fixture.period.end,
      sourceReadCutoffAt: fixture.now,
      createdAt: fixture.now,
      wireAdjustment: wireAdjustmentWithoutDigest,
    };
    const inserted = await core.commitAdjustment(legacyAdjustment, fixture.coreLease);
    assert.equal(inserted.inserted, true);

    const upgraded = {
      ...legacyAdjustment,
      wireAdjustment: {
        ...wireAdjustmentWithoutDigest,
        canonical_adjustment_sha256: createHash('sha256')
          .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
          .digest('hex'),
      },
    };
    const replayedAdjustment = await core.commitAdjustment(upgraded, fixture.coreLease);
    assert.equal(replayedAdjustment.inserted, false);
    assert.equal(
      replayedAdjustment.value.wireAdjustment.canonical_adjustment_sha256,
      undefined,
      'the pre-upgrade adjustment row survives the replay untouched'
    );
    await assert.rejects(
      () =>
        core.commitAdjustment(
          {
            ...legacyAdjustment,
            wireAdjustment: { ...wireAdjustmentWithoutDigest, canonical_adjustment_sha256: 'a'.repeat(64) },
          },
          fixture.coreLease
        ),
      /transaction failed/,
      'only the digest RC3 derives from the stored content is tolerated'
    );
  });

  test('exposes every consumer receipt chain to the lifecycle projection', async () => {
    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: snapshotFixture.obligation.reporting_obligation_id,
      ledgerAsOf: new Date(Date.parse(snapshotFixture.now) + 600_000).toISOString(),
    });
    assert.equal(projection.binding.configurationId, snapshotFixture.configuration.configurationId);
    assert.ok(projection.materializationHistory.length >= 1);
    assert.deepEqual(
      projection.consumers.map(value => value.consumer_id),
      ['https://snapshot-buyer.example']
    );
    assert.ok(projection.consumers[0].receipts.length >= 1);
    assert.equal(
      await core.getManagedLifecycleProjection({
        reporting_obligation_id: 'obligation-does-not-exist',
        ledgerAsOf: snapshotFixture.now,
      }),
      null
    );
    // Nothing durable enumerates who owes a receipt, so the bundled store
    // cannot claim a complete roster on its own.
    assert.equal(projection.obligatedConsumerRosterComplete, false);

    // The supported seam: a seller whose authorization layer does know the
    // roster supplies it and gets accurate reconciled transitions. Without it
    // the fold stays conservative forever.
    const rosterAware = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async input => {
        assert.equal(input.reporting_obligation_id, snapshotFixture.obligation.reporting_obligation_id);
        assert.equal(input.account_id, snapshotFixture.accountId);
        return { ids: ['https://snapshot-buyer.example', 'https://governance.example'], complete: true };
      },
    });
    const supplied = await rosterAware.getManagedLifecycleProjection({
      reporting_obligation_id: snapshotFixture.obligation.reporting_obligation_id,
      ledgerAsOf: new Date(Date.parse(snapshotFixture.now) + 600_000).toISOString(),
    });
    assert.equal(supplied.obligatedConsumerRosterComplete, true);
    assert.deepEqual(supplied.obligatedConsumerIds, ['https://governance.example', 'https://snapshot-buyer.example']);

    // The hook's documented purpose is an external authorization lookup, so it
    // must never be awaited inside the authoritative transaction: a hung auth
    // service would pin a pooled connection and a snapshot per reconcile, and
    // the managed store shares the Core pool. Prove it by issuing an
    // independent query from inside the callback — that can only succeed if a
    // connection is free, which it is not while the store's own transaction is
    // still open on a single-connection pool.
    const { Pool } = require('pg');
    const singleConnection = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path="${schema}"`,
      max: 1,
    });
    try {
      let reentrantRows = -1;
      const serialized = new ledger.PostgresReportingLedgerStore(singleConnection, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
        obligatedConsumers: async () => {
          const probe = await singleConnection.query('SELECT 1 AS ok');
          reentrantRows = probe.rowCount;
          return { ids: ['https://snapshot-buyer.example'], complete: true };
        },
      });
      const outside = await serialized.getManagedLifecycleProjection({
        reporting_obligation_id: snapshotFixture.obligation.reporting_obligation_id,
        ledgerAsOf: new Date(Date.parse(snapshotFixture.now) + 600_000).toISOString(),
      });
      assert.equal(reentrantRows, 1, 'the callback runs with the store transaction already committed');
      assert.equal(outside.obligatedConsumerRosterComplete, true);
    } finally {
      await singleConnection.end();
    }
  });

  test('settles a lease issued under host clock skew against the database clock', async () => {
    const skewed = await seedSkewLedger();
    // A worker whose host clock is ten minutes behind the database. Before the
    // lease was issued from clock_timestamp(), the claim succeeded and the
    // settle matched zero rows, stranding the row at status 'pending'
    // attempt 1 where the planner's HAVING cannot see it — so the attempt cap
    // never engaged and the adapter was re-asked to deliver without bound.
    const behind = new Date(Date.now() - 10 * 60_000).toISOString();
    await managed.planMaterializations({ account_id: skewed.accountId });
    const claimed = await managed.claimMaterialization({
      owner: 'skewed-worker',
      now: behind,
      lease_milliseconds: 65_000,
      account_id: skewed.accountId,
    });
    assert.ok(claimed, 'the skewed worker can still claim');
    assert.ok(
      Date.parse(claimed.expires_at) > Date.now() - 60_000,
      'the committed expiry comes from the database clock, not the caller'
    );
    const settled = await managed.settleMaterialization({
      lease: claimed,
      now: behind,
      outcome: materializationOutcome(skewed),
    });
    assert.equal(settled, true, 'host clock skew must not strand a delivered materialization');
    const rows = await pool.query(
      `SELECT status FROM adcp_reporting_materializations WHERE obligation_id = $1 ORDER BY attempt`,
      [skewed.obligation.reporting_obligation_id]
    );
    assert.deepEqual(
      rows.rows.map(row => row.status),
      ['available'],
      'the row leaves pending instead of being re-delivered forever'
    );

    // Same single-clock rule for revocation cleanup.
    await managed.revokeDestination({
      account_id: skewed.accountId,
      destination_ref: skewed.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const cleanup = await managed.claimRevocation({
      owner: 'skewed-cleanup-worker',
      now: behind,
      lease_milliseconds: 65_000,
      account_id: skewed.accountId,
    });
    assert.ok(cleanup);
    assert.equal(
      await managed.completeRevocation({ lease: cleanup, completed_at: new Date().toISOString() }),
      true,
      'host clock skew must not prevent provider grant cleanup from committing'
    );
  });

  test('accepts an adjustment rejection whose digests agree', async () => {
    const semantic = await seedSkewLedger('semantic', 'consumer_receipt');
    const rows = [{ media_buy_id: 'buy-3', impressions: 11 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-semantic-0001',
      adjusts_reporting_revision_id: semantic.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: semantic.period.start, end: semantic.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: semantic.now,
      created_at: semantic.now,
    };
    const canonicalAdjustmentSha256 = createHash('sha256')
      .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
      .digest('hex');
    await core.commitAdjustment(
      {
        reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
        reporting_obligation_id: semantic.obligation.reporting_obligation_id,
        adjusts_reporting_revision_id: semantic.revision.reporting_revision_id,
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'semantic-manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'adjustment-publication-semantic',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: rows.length,
        },
        rows,
        observedAt: semantic.now,
        dataThrough: semantic.period.end,
        sourceReadCutoffAt: semantic.now,
        createdAt: semantic.now,
        wireAdjustment: { ...wireAdjustmentWithoutDigest, canonical_adjustment_sha256: canonicalAdjustmentSha256 },
      },
      semantic.coreLease
    );

    const context = { account: { id: semantic.accountId }, agent: { agent_url: 'https://semantic-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const adjustmentReceipt = overrides => ({
      reporting_receipt_id: 'adjustment-receipt-semantic-0001',
      reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
      adjusts_reporting_revision_id: semantic.revision.reporting_revision_id,
      observed_adjustment_sha256: canonicalAdjustmentSha256,
      observed_at: semantic.now,
      ...overrides,
    });

    // RC3 acceptance_match: "A digest OR SEMANTIC disagreement is rejected with
    // stable rejection_codes." A semantic disagreement has matching digests, so
    // requiring a digest mismatch to reject made the class unfileable, and an
    // accepted leaf being terminal left reconciliation with no exit at all.
    const semanticRejection = await sync(
      {
        idempotency_key: 'adjustment-semantic-reject-0001',
        adjustment_receipts: [adjustmentReceipt({ status: 'rejected', rejection_codes: ['SEMANTIC_MISMATCH'] })],
      },
      context
    );
    assert.equal(semanticRejection.results[0].result, 'recorded');
    assert.equal(validateResponse('sync_reporting_receipts', semanticRejection, '3.2.0-rc.3').valid, true);

    // Negative controls: a rejection with no codes, and an acceptance whose
    // digest disagrees, both stay refused.
    const uncoded = await sync(
      {
        idempotency_key: 'adjustment-semantic-reject-0002',
        adjustment_receipts: [
          adjustmentReceipt({ reporting_receipt_id: 'adjustment-receipt-semantic-0002', status: 'rejected' }),
        ],
      },
      context
    );
    assert.equal(uncoded.results[0].result, 'failed');
    const mismatchedAccept = await sync(
      {
        idempotency_key: 'adjustment-semantic-accept-0001',
        adjustment_receipts: [
          adjustmentReceipt({
            reporting_receipt_id: 'adjustment-receipt-semantic-0003',
            status: 'accepted',
            observed_adjustment_sha256: '1'.repeat(64),
          }),
        ],
      },
      context
    );
    assert.equal(mismatchedAccept.results[0].result, 'failed');
  });

  test('refuses a binding replay whose fingerprint was copied from different content', async () => {
    const authentic = fixture.binding;
    // Same configuration identity, different immutable content, carrying the
    // stored fingerprint. The replay branch used to trust the supplied value
    // and accept this as an idempotent no-op.
    await assert.rejects(
      () =>
        managed.installBinding({
          ...authentic,
          resource_retention_days: authentic.resource_retention_days + 1,
          semantic_fingerprint: authentic.semantic_fingerprint,
        }),
      /semantic fingerprint does not match its immutable content/
    );
    const stored = await pool.query('SELECT data FROM adcp_reporting_managed_bindings WHERE configuration_id = $1', [
      authentic.configurationId,
    ]);
    assert.equal(
      stored.rows[0].data.resource_retention_days,
      authentic.resource_retention_days,
      'the stored immutable binding is untouched'
    );
    assert.deepEqual(await managed.installBinding(authentic), { inserted: false }, 'an exact replay still succeeds');
  });

  test('scopes adjustment receipts to the adjustments the view returns', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://semantic-buyer.example' } };
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const revisionView = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'revision',
        reporting_revision_id: fixture.revision.reporting_revision_id,
      },
      context
    );
    const returnedAdjustmentIds = new Set(revisionView.adjustments.map(value => value.reporting_adjustment_id));
    for (const value of revisionView.adjustment_receipts ?? []) {
      assert.ok(
        returnedAdjustmentIds.has(value.reporting_adjustment_id),
        'RC3 revision_adjustments: every adjustment_receipt must name one of those adjustments'
      );
    }
    assert.equal(
      validateResponse('get_reporting_status', revisionView, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', revisionView, '3.2.0-rc.3').issues)
    );

    // An unrelated revision returns no adjustments, so it must return no
    // adjustment receipts either.
    const unrelated = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'revision',
        reporting_revision_id: snapshotFixture.revision.reporting_revision_id,
      },
      { account: { id: snapshotFixture.accountId }, agent: { agent_url: 'https://semantic-buyer.example' } }
    );
    assert.deepEqual(unrelated.adjustments, []);
    assert.deepEqual(unrelated.adjustment_receipts ?? [], []);
  });

  async function seedSkewLedger(suffix = 'skew', reconciliationMode = 'delivery_only') {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 10_800_000).toISOString(),
      end: new Date(nowMs - 9_000_000).toISOString(),
    };
    const accountId = `account-managed-${suffix}`;
    const configuration = {
      configurationId: `configuration-managed-${suffix}-1`,
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: `${suffix}-files`,
      delivery_config_version: 1,
      offeringId: `${suffix}-files-v1`,
      report_definition_id: 'analytics-v1',
      feedPurpose: 'analytics',
      requiredFinality: 'official',
      canonicalization: {
        id: 'analytics-rows-v1',
        uri: 'https://schemas.fixture.example/canonicalization.json',
        sha256: 'c'.repeat(64),
        primaryKeys: ['media_buy_id'],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-3'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: period.start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'analytics-v1' },
      installedAt: period.start,
      semanticFingerprint: `configuration-managed-${suffix}-fingerprint`,
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: `destination-${suffix}-1`,
      generation: 1,
      authorized_at: now,
    });
    const binding = ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: `destination-${suffix}-1`,
      authorization_generation: 1,
      feed_purpose: 'analytics',
      method: 'file_transfer',
      transport: 'fixture_object_store',
      verification_profile: 'canonical_digest',
      reconciliation_mode: reconciliationMode,
      resource_retention_days: 30,
      created_at: now,
    });
    await managed.installBinding(binding);
    const obligation = {
      reporting_obligation_id: `obligation-managed-${suffix}-1`,
      configurationId: configuration.configurationId,
      account: configuration.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: configuration.offeringId,
      report_definition_id: configuration.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'official',
      periodOrdinal: 0,
      period: { ...period, sourceTimezone: 'UTC' },
      schedule: configuration.schedule,
      scopeResolvedAt: period.end,
      coverage: {
        status: 'full',
        evaluatedAt: period.end,
        mediaBuyIds: ['buy-3'],
        fullyCoveredMediaBuyIds: ['buy-3'],
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-3'],
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: period.end,
      recoveryDeadlineAt: new Date(Date.parse(period.end) + 60_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: `obligation-managed-${suffix}-fingerprint`,
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({
      owner: `${suffix}-core-worker`,
      now,
      leaseMilliseconds: 600_000,
      account_id: accountId,
    });
    const rows = [{ media_buy_id: 'buy-3', impressions: 4 }];
    const controlTotals = [{ name: 'impressions', value: '4', value_type: 'integer', unit: 'impressions' }];
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: `revision-managed-${suffix}-1`,
        row_count: rows.length,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const digest = {
      algorithm: 'sha256',
      value: '6'.repeat(64),
      canonicalization_id: 'analytics-rows-v1',
      canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
      canonicalization_sha256: 'c'.repeat(64),
    };
    const revision = {
      reporting_revision_id: `revision-managed-${suffix}-1`,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-managed-${suffix}-1`,
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
        reporting_revision_id: `revision-managed-${suffix}-1`,
        revision_content_sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        report_definition_id: 'analytics-v1',
        report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
        report_definition_sha256: '9'.repeat(64),
        reporting_profile: 'analytics-v1',
        schema_version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: '8'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        account_id: accountId,
        media_buy_ids: ['buy-3'],
        coverage: {
          status: 'full',
          evaluated_at: now,
          media_buy_ids: ['buy-3'],
          fully_covered_media_buy_ids: ['buy-3'],
          partially_covered_media_buy_ids: [],
          unsupported_media_buy_ids: [],
          unknown_media_buy_ids: [],
          package_ids: [],
          covered_package_ids: [],
          unsupported_package_ids: [],
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

  test('refuses a lifecycle apply whose managed state moved under it', async () => {
    const race = await seedSkewLedger('cas', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(race),
      read: async () => Buffer.from('cas bytes'),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: race.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(race.now) + 1000),
      maxIterations: 2,
      account_id: race.accountId,
    });

    const ledgerAsOf = new Date(Date.parse(race.now) + 600_000).toISOString();
    const before = await core.getManagedLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      ledgerAsOf,
    });
    assert.ok(before.managedStateVersion, 'the projection carries a managed-state token');

    // A managed write lands between projection and apply. The stale apply must
    // be refused rather than persisting a health computed before it existed.
    await managed.revokeDestination({
      account_id: race.accountId,
      destination_ref: race.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const after = await core.getManagedLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      ledgerAsOf,
    });
    assert.notEqual(
      after.managedStateVersion,
      before.managedStateVersion,
      'a revocation moves the token; a token that never moves would make the CAS vacuous'
    );

    const stale = await core.applyLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      expectedRevisionIds: [race.revision.reporting_revision_id],
      expectedPreviousHealth: 'waiting',
      expectedObligationState: race.obligation.state,
      expectedAttemptCount: race.obligation.attemptCount,
      projectedIssues: [],
      ledgerAsOf,
      expectedManagedStateVersion: before.managedStateVersion,
    });
    assert.equal(stale.applied, false, 'a stale managed-state token is refused');

    const current = await core.applyLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      expectedRevisionIds: [race.revision.reporting_revision_id],
      expectedPreviousHealth: 'waiting',
      expectedObligationState: race.obligation.state,
      expectedAttemptCount: race.obligation.attemptCount,
      projectedIssues: [],
      ledgerAsOf,
      expectedManagedStateVersion: after.managedStateVersion,
    });
    assert.equal(current.applied, true, 'the same apply succeeds once the token matches — the CAS is not vacuous');
  });

  test('settles provider cleanup durably when the advertised window is zero', async () => {
    const zero = await seedSkewLedger('zerowindow');
    await managed.revokeDestination({
      account_id: zero.accountId,
      destination_ref: zero.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    let attempts = 0;
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(zero),
      read: async () => Buffer.from(''),
      // Slower than a trivial call, to prove the lease actually outlives the
      // work rather than passing because the work was instantaneous.
      revoke: async () => {
        attempts += 1;
        await new Promise(resolve => setTimeout(resolve, 60));
      },
    };
    // A zero-second promise used to scale the lease to 1 ms, which
    // completeRevocation fences against clock_timestamp() — so cleanup could
    // never commit and the grant was stranded forever.
    const result = await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 3,
      account_id: zero.accountId,
      authorizationRevocationSeconds: 0,
      leaseMilliseconds: 30_000,
      deliveryDeadlineMilliseconds: 10_000,
    });
    assert.equal(attempts, 1, 'bounded: the settled grant is not reselected');
    assert.equal(result.revocationsCompleted, 1, 'cleanup commits durably under a zero-second window');
    assert.ok(result.revocationsOverdue >= 1, 'a zero-second window is still reported as overdue');
    const row = await pool.query(
      `SELECT cleanup_completed_at FROM adcp_reporting_destination_authorizations
        WHERE account_id = $1 AND destination_ref = $2 AND generation = 1`,
      [zero.accountId, zero.binding.destination_ref]
    );
    assert.ok(row.rows[0].cleanup_completed_at, 'the durable cleanup marker is set');
  });

  test('orders receipts by the database clock even when the caller clock is skewed', async () => {
    const skewLedger = await seedSkewLedger('receiptclock', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(skewLedger),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: skewLedger.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(skewLedger.now) + 1000),
      maxIterations: 2,
      account_id: skewLedger.accountId,
    });
    const stored = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [skewLedger.obligation.reporting_obligation_id]
    );
    skewLedger.materialization = stored.rows[0].data;

    const context = {
      account: { id: skewLedger.accountId },
      agent: { agent_url: 'https://receiptclock-buyer.example' },
    };
    // A host a year in the past. Nothing durable may take that value.
    const skewed = new Date(Date.now() - 365 * 86_400_000);
    const sync = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => skewed
    );
    const response = await sync(
      {
        idempotency_key: 'receipt-clock-skew-0001',
        receipts: [receipt(skewLedger, { reporting_receipt_id: 'receipt-clock-skew-0001' })],
      },
      context
    );
    assert.equal(response.results[0].result, 'recorded');
    const wireReceivedAt = Date.parse(response.results[0].receipt.received_at);
    assert.ok(
      wireReceivedAt > Date.now() - 600_000,
      'the published received_at comes from the database, not the skewed host'
    );
    const columns = await pool.query(
      `SELECT received_at, recorded_at FROM adcp_reporting_receipts WHERE reporting_receipt_id = $1`,
      ['receipt-clock-skew-0001']
    );
    assert.equal(
      columns.rows[0].received_at.toISOString(),
      columns.rows[0].recorded_at.toISOString(),
      'the instant a consumer is shown is the instant its receipt sorts and becomes visible at'
    );

    // The status read and the lifecycle projection must agree about it.
    const status = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })({ account: { account_id: skewLedger.accountId }, view: 'periods', period: skewLedger.period }, context);
    assert.equal(status.periods[0].receipt_count, 1);
    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: skewLedger.obligation.reporting_obligation_id,
      ledgerAsOf: status.ledger_as_of,
    });
    assert.deepEqual(
      projection.consumers.map(value => value.receipts.length),
      [1],
      'the lifecycle projection sees the same receipt the status read does'
    );
  });

  test('frees managed capacity by pruning evidence past its retention', async () => {
    const aged = await seedSkewLedger('retention');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(aged),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: aged.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(aged.now) + 1000),
      maxIterations: 2,
      account_id: aged.accountId,
    });

    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 30 });
    assert.deepEqual(
      await retaining.pruneExpiredEvidence({ account_id: aged.accountId }),
      { materializations: 0, receipts: 0, batches: 0 },
      'nothing inside the retention window is ever removed'
    );

    // Age the settled materialization past the window.
    await pool.query(
      `UPDATE adcp_reporting_materializations SET recorded_at = clock_timestamp() - INTERVAL '90 days'
        WHERE account_id = $1`,
      [aged.accountId]
    );
    const pruned = await retaining.pruneExpiredEvidence({ account_id: aged.accountId });
    assert.equal(pruned.materializations, 1, 'evidence past the advertised retention frees capacity');

    // A lifetime cap would have counted the aged row forever; active scope does not.
    const lifetime = await pool.query(
      `SELECT COUNT(*)::integer AS count FROM adcp_reporting_materializations WHERE account_id = $1`,
      [aged.accountId]
    );
    assert.equal(lifetime.rows[0].count, 0);
    assert.equal(
      await retaining.planMaterializations({ account_id: aged.accountId }),
      1,
      'the account keeps working after reaching and clearing its cap'
    );

    // Without the option the store keeps its previous lifetime accounting and
    // refuses to prune rather than silently deleting retained evidence.
    await assert.rejects(
      () => managed.pruneExpiredEvidence({ account_id: aged.accountId }),
      /requires PostgresReportingManagedDeliveryStore\(\{ evidenceRetentionDays \}\)/
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

  async function seedSnapshotFinalityLedger() {
    // A non-billing consumer_receipt contract whose Core configuration requires
    // only snapshot finality. Legal under RC3 and previously unreconcilable.
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 7_200_000).toISOString(),
      end: new Date(nowMs - 5_400_000).toISOString(),
    };
    const accountId = 'account-managed-snapshot';
    const canonicalization = {
      id: 'analytics-rows-v1',
      uri: 'https://schemas.fixture.example/canonicalization.json',
      sha256: 'c'.repeat(64),
      primaryKeys: ['media_buy_id'],
    };
    const configuration = {
      configurationId: 'configuration-managed-snapshot-1',
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: 'analytics-files',
      delivery_config_version: 1,
      offeringId: 'analytics-files-v1',
      report_definition_id: 'analytics-v1',
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      canonicalization,
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-2'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: period.start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'analytics-v1' },
      installedAt: period.start,
      semanticFingerprint: 'configuration-managed-snapshot-fingerprint',
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-snapshot-1',
      generation: 1,
      authorized_at: now,
    });
    const binding = ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: 'destination-snapshot-1',
      authorization_generation: 1,
      feed_purpose: 'analytics',
      method: 'file_transfer',
      transport: 'fixture_object_store',
      verification_profile: 'canonical_digest',
      reconciliation_mode: 'consumer_receipt',
      resource_retention_days: 30,
      created_at: now,
    });
    await managed.installBinding(binding);
    const obligation = {
      reporting_obligation_id: 'obligation-managed-snapshot-1',
      configurationId: configuration.configurationId,
      account: configuration.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: configuration.offeringId,
      report_definition_id: configuration.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      periodOrdinal: 0,
      period: { ...period, sourceTimezone: 'UTC' },
      schedule: configuration.schedule,
      scopeResolvedAt: period.end,
      coverage: {
        status: 'full',
        evaluatedAt: period.end,
        mediaBuyIds: ['buy-2'],
        fullyCoveredMediaBuyIds: ['buy-2'],
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-2'],
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: period.end,
      recoveryDeadlineAt: new Date(Date.parse(period.end) + 60_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: 'obligation-managed-snapshot-fingerprint',
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({
      owner: 'snapshot-core-worker',
      now,
      leaseMilliseconds: 600_000,
      account_id: accountId,
    });
    const rows = [{ media_buy_id: 'buy-2', impressions: 9 }];
    const controlTotals = [{ name: 'impressions', value: '9', value_type: 'integer', unit: 'impressions' }];
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: 'revision-managed-snapshot-1',
        row_count: rows.length,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const digest = {
      algorithm: 'sha256',
      value: '5'.repeat(64),
      canonicalization_id: canonicalization.id,
      canonicalization_uri: canonicalization.uri,
      canonicalization_sha256: canonicalization.sha256,
    };
    const revision = {
      reporting_revision_id: 'revision-managed-snapshot-1',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      kind: 'snapshot',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'publication-managed-snapshot-1',
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
        reporting_revision_id: 'revision-managed-snapshot-1',
        revision_content_sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        report_definition_id: 'analytics-v1',
        report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
        report_definition_sha256: '9'.repeat(64),
        reporting_profile: 'analytics-v1',
        schema_version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: '8'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        account_id: accountId,
        media_buy_ids: ['buy-2'],
        coverage: {
          status: 'full',
          evaluated_at: now,
          media_buy_ids: ['buy-2'],
          fully_covered_media_buy_ids: ['buy-2'],
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
        finality: 'snapshot',
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
