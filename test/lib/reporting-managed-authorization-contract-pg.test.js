/**
 * Destination authorization generations record the delivery pattern and
 * transport they serve, so a revocation can be routed to the transport that
 * holds the provider grant.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test \
 *   node --test test/lib/reporting-managed-authorization-contract-pg.test.js
 */
const assert = require('node:assert/strict');
const {
  newReportingLedgerStoreForTest,
  reportingLedgerMigrationForTest,
} = require('../helpers/reporting-row-storage-mode.js');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('destination authorization pattern and transport', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_authz_contract_${process.pid}`;
  const accountId = 'account-authz-contract';
  const now = new Date().toISOString();
  let bootstrap;
  let pool;
  let ledger;
  let core;
  let managed;
  let sequence = 0;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(reportingLedgerMigrationForTest(ledger));
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    core = newReportingLedgerStoreForTest(ledger, pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
    });
    managed = new ledger.PostgresReportingManagedDeliveryStore(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  // The store wraps a failed transaction; the reason is on the cause.
  const causeMatching = pattern => error => pattern.test(error.cause?.message ?? error.message);

  async function putConfiguration() {
    sequence += 1;
    const start = new Date(Date.now() - 3_600_000).toISOString();
    const configuration = {
      configurationId: `configuration-authz-contract-${sequence}`,
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: `authz-contract-files-${sequence}`,
      delivery_config_version: 1,
      offeringId: `authz-contract-files-${sequence}-v1`,
      report_definition_id: 'analytics-v1',
      feedPurpose: 'analytics',
      requiredFinality: 'provisional',
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-1'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'analytics-v1' },
      installedAt: start,
      semanticFingerprint: `configuration-authz-contract-fingerprint-${sequence}`,
    };
    await core.putConfiguration(configuration);
    return configuration;
  }

  function bindingFor(configuration, destinationRef, overrides = {}) {
    return ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: destinationRef,
      authorization_generation: 1,
      feed_purpose: 'analytics',
      method: 'file_transfer',
      transport: 'gcs',
      verification_profile: 'manifest_checksums',
      reconciliation_mode: 'delivery_only',
      resource_retention_days: 30,
      created_at: now,
      ...overrides,
    });
  }

  async function stored(destinationRef, generation = 1) {
    const result = await pool.query(
      `SELECT pattern, transport, data FROM adcp_reporting_destination_authorizations
        WHERE account_id = $1 AND destination_ref = $2 AND generation = $3`,
      [accountId, destinationRef, generation]
    );
    return result.rows[0];
  }

  test('records pattern and transport when the generation is created and hands them to revocation', async () => {
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-recorded',
      generation: 1,
      authorized_at: now,
      pattern: 'file_transfer',
      transport: 'gcs',
    });
    const row = await stored('destination-recorded');
    assert.equal(row.pattern, 'file_transfer');
    assert.equal(row.transport, 'gcs');
    assert.equal(row.data.transport, 'gcs');
    assert.equal(
      await managed.revokeDestination({
        account_id: accountId,
        destination_ref: 'destination-recorded',
        generation: 1,
        revoked_at: now,
      }),
      true
    );
    const lease = await managed.claimRevocation({
      owner: 'authz-contract-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 60_000,
      account_id: accountId,
    });
    assert.equal(lease.authorization.destination_ref, 'destination-recorded');
    assert.equal(lease.authorization.pattern, 'file_transfer');
    assert.equal(lease.authorization.transport, 'gcs');
    await managed.completeRevocation({ lease, completed_at: new Date().toISOString() });
  });

  test('a generation created without a contract stays NULL and carries no pattern or transport', async () => {
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-legacy-shape',
      generation: 1,
      authorized_at: now,
    });
    const row = await stored('destination-legacy-shape');
    assert.equal(row.pattern, null);
    assert.equal(row.transport, null);
    assert.equal('transport' in row.data, false);
    await managed.revokeDestination({
      account_id: accountId,
      destination_ref: 'destination-legacy-shape',
      generation: 1,
      revoked_at: now,
    });
    const lease = await managed.claimRevocation({
      owner: 'authz-contract-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 60_000,
      account_id: accountId,
    });
    assert.equal(lease.authorization.destination_ref, 'destination-legacy-shape');
    assert.equal('pattern' in lease.authorization, false);
    assert.equal('transport' in lease.authorization, false);
    await managed.completeRevocation({ lease, completed_at: new Date().toISOString() });
  });

  test('rejects a malformed contract before writing anything', async () => {
    const base = { account_id: accountId, destination_ref: 'destination-malformed', generation: 1, authorized_at: now };
    await assert.rejects(() => managed.authorizeDestination({ ...base, pattern: 'sftp' }), /pattern must be/);
    await assert.rejects(() => managed.authorizeDestination({ ...base, transport: 'gcs' }), /requires its pattern/);
    await assert.rejects(
      () => managed.authorizeDestination({ ...base, pattern: 'file_transfer', transport: 'GCS Bucket' }),
      /transport must match/
    );
    assert.equal(await stored('destination-malformed'), undefined);
  });

  test('pattern and transport are immutable for a generation', async () => {
    const base = { account_id: accountId, destination_ref: 'destination-immutable', generation: 1, authorized_at: now };
    await managed.authorizeDestination({ ...base, pattern: 'file_transfer', transport: 'gcs' });
    await managed.authorizeDestination({ ...base, pattern: 'file_transfer', transport: 'gcs' });
    await managed.authorizeDestination(base);
    await assert.rejects(
      () => managed.authorizeDestination({ ...base, pattern: 'file_transfer', transport: 's3' }),
      causeMatching(/immutable for a generation/)
    );
    await assert.rejects(
      () => managed.authorizeDestination({ ...base, pattern: 'dataset_share', transport: 'gcs' }),
      causeMatching(/immutable for a generation/)
    );
    const row = await stored('destination-immutable');
    assert.equal(row.pattern, 'file_transfer');
    assert.equal(row.transport, 'gcs');

    // A generation recorded without a contract cannot be given one later by a replay.
    const legacy = { ...base, destination_ref: 'destination-immutable-legacy' };
    await managed.authorizeDestination(legacy);
    await assert.rejects(
      () => managed.authorizeDestination({ ...legacy, pattern: 'file_transfer', transport: 'gcs' }),
      causeMatching(/immutable for a generation/)
    );
    assert.equal((await stored('destination-immutable-legacy')).transport, null);
  });

  test('a binding must agree with the contract recorded on its generation', async () => {
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-agree',
      generation: 1,
      authorized_at: now,
      pattern: 'file_transfer',
      transport: 'gcs',
    });
    const wrongTransport = await putConfiguration();
    await assert.rejects(
      () => managed.installBinding(bindingFor(wrongTransport, 'destination-agree', { transport: 's3' })),
      causeMatching(/destination authorization/)
    );
    const missingTransport = await putConfiguration();
    await assert.rejects(
      () => managed.installBinding(bindingFor(missingTransport, 'destination-agree', { transport: undefined })),
      causeMatching(/destination authorization/)
    );
    const wrongPattern = await putConfiguration();
    await assert.rejects(
      () => managed.installBinding(bindingFor(wrongPattern, 'destination-agree', { method: 'dataset_share' })),
      causeMatching(/destination authorization/)
    );
    const agreeing = await putConfiguration();
    assert.deepEqual(await managed.installBinding(bindingFor(agreeing, 'destination-agree')), { inserted: true });
  });

  test('re-applying the migration is safe and changes nothing recorded', async () => {
    const before = await pool.query(
      `SELECT account_id, destination_ref, generation::text, pattern, transport, data
         FROM adcp_reporting_destination_authorizations ORDER BY account_id, destination_ref, generation`
    );
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    const after = await pool.query(
      `SELECT account_id, destination_ref, generation::text, pattern, transport, data
         FROM adcp_reporting_destination_authorizations ORDER BY account_id, destination_ref, generation`
    );
    assert.deepEqual(after.rows, before.rows);
  });

  test('upgrade backfills only the generations whose bindings agree, once, and reports the rest', async () => {
    const authorize = ref =>
      managed.authorizeDestination({ account_id: accountId, destination_ref: ref, generation: 1, authorized_at: now });
    for (const ref of [
      'legacy-agree',
      'legacy-agree-many',
      'legacy-disagree-transport',
      'legacy-disagree-pattern',
      'legacy-no-transport',
      'legacy-mixed-transport',
      'legacy-no-binding',
    ]) {
      await authorize(ref);
    }
    const install = async (ref, overrides) =>
      managed.installBinding(bindingFor(await putConfiguration(), ref, overrides));
    await install('legacy-agree', { transport: 's3' });
    await install('legacy-agree-many', { transport: 'gcs' });
    await install('legacy-agree-many', { transport: 'gcs', verification_profile: 'canonical_digest' });
    await install('legacy-disagree-transport', { transport: 'gcs' });
    await install('legacy-disagree-transport', { transport: 's3' });
    await install('legacy-disagree-pattern', { transport: 'gcs' });
    await install('legacy-disagree-pattern', { transport: 'gcs', method: 'warehouse_materialization' });
    await install('legacy-no-transport', { transport: undefined });
    await install('legacy-mixed-transport', { transport: 'gcs' });
    await install('legacy-mixed-transport', { transport: undefined });

    // Put the table back into its pre-upgrade shape.
    await pool.query(`
      UPDATE adcp_reporting_destination_authorizations SET data = data - 'pattern' - 'transport';
      ALTER TABLE adcp_reporting_destination_authorizations DROP COLUMN pattern, DROP COLUMN transport;
    `);
    const notices = [];
    const client = await pool.connect();
    client.on('notice', notice => notices.push(notice.message));
    try {
      await client.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    } finally {
      client.release();
    }

    const expected = {
      'legacy-agree': ['file_transfer', 's3'],
      'legacy-agree-many': ['file_transfer', 'gcs'],
      'legacy-disagree-transport': [null, null],
      'legacy-disagree-pattern': [null, null],
      'legacy-no-transport': [null, null],
      'legacy-mixed-transport': [null, null],
      'legacy-no-binding': [null, null],
    };
    for (const [ref, [pattern, transport]] of Object.entries(expected)) {
      const row = await stored(ref);
      assert.deepEqual([row.pattern, row.transport], [pattern, transport], ref);
      assert.equal(row.data.transport ?? null, transport, `${ref} data mirrors the column`);
    }
    assert.ok(
      notices.some(message => /generation\(s\) left without pattern\/transport/.test(message)),
      'the backfill reports what it could not infer'
    );

    const unresolved = await managed.listDestinationAuthorizationsWithoutContract({ account_id: accountId });
    const reasons = Object.fromEntries(
      unresolved.filter(row => row.destination_ref.startsWith('legacy-')).map(row => [row.destination_ref, row.reason])
    );
    assert.deepEqual(reasons, {
      'legacy-disagree-pattern': 'bindings_disagree',
      'legacy-disagree-transport': 'bindings_disagree',
      'legacy-mixed-transport': 'binding_without_transport',
      'legacy-no-binding': 'no_binding',
      'legacy-no-transport': 'binding_without_transport',
    });

    // The backfill runs once. A later binding does not re-decide a generation
    // that was left unrecorded, and re-applying changes nothing.
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    for (const [ref, [pattern, transport]] of Object.entries(expected)) {
      const row = await stored(ref);
      assert.deepEqual([row.pattern, row.transport], [pattern, transport], `${ref} after re-apply`);
    }

    // A backfilled generation now holds later bindings to its contract.
    await assert.rejects(
      async () => managed.installBinding(bindingFor(await putConfiguration(), 'legacy-agree', { transport: 'gcs' })),
      causeMatching(/destination authorization/)
    );
  });
});
