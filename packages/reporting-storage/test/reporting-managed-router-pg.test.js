/**
 * The managed-delivery router over the real PostgreSQL store: install-time
 * admission, delivery and revocation dispatch, legacy authorizations, fencing
 * on both routes, and retry accounting that stays per materialization.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-managed-router-pg.test.js
 */
const assert = require('node:assert/strict');
const {
  newReportingLedgerStoreForTest,
  reportingLedgerMigrationForTest,
} = require('./helpers/reporting-row-storage-mode.js');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const RUNTIME_POLICY = {
  automatedRecoveryWindowSeconds: 3600,
  statusRetentionDays: 90,
  resourceRetentionDays: 30,
  authorizationRevocationSeconds: 60,
};

describe('managed-delivery router over PostgreSQL', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_router_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let canonicalize;
  let core;
  let managed;
  let sequence = 0;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    canonicalize = require('@adcp/sdk').canonicalize;
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(reportingLedgerMigrationForTest(ledger));
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    core = newReportingLedgerStoreForTest(ledger, pool, { acknowledgeIsolatedDatabase: true, managedDelivery: true });
    // Seeds without a runtime, so no admission is registered on it.
    managed = new ledger.PostgresReportingManagedDeliveryStore(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  // ---- fixtures -----------------------------------------------------------

  /** A Core configuration for a fresh account. No obligation yet, so a binding can still be installed. */
  async function seedConfiguration() {
    sequence += 1;
    const suffix = `r${sequence}`;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 7_200_000).toISOString(),
      end: new Date(nowMs - 5_400_000).toISOString(),
    };
    const accountId = `account-router-${suffix}`;
    const canonicalization = {
      id: 'analytics-rows-v1',
      uri: 'https://schemas.fixture.example/canonicalization.json',
      sha256: 'c'.repeat(64),
      primaryKeys: ['media_buy_id'],
    };
    const configuration = {
      configurationId: `configuration-router-${suffix}-1`,
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: 'router-files',
      delivery_config_version: 1,
      offeringId: 'router-files-v1',
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
      semanticFingerprint: `configuration-router-${suffix}-fingerprint`,
    };
    await core.putConfiguration(configuration);
    return {
      suffix,
      accountId,
      now,
      period,
      configuration,
      canonicalization,
      destinationRef: `destination-${suffix}-1`,
    };
  }

  function bindingFor(fixture, overrides = {}) {
    return ledger.reportingManagedDeliveryBindingV1({
      configurationId: fixture.configuration.configurationId,
      account_id: fixture.accountId,
      delivery_config_id: fixture.configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: fixture.destinationRef,
      authorization_generation: 1,
      feed_purpose: 'analytics',
      method: 'file_transfer',
      transport: 'gcs',
      verification_profile: 'canonical_digest',
      reconciliation_mode: 'delivery_only',
      resource_retention_days: 30,
      created_at: fixture.now,
      ...overrides,
    });
  }

  async function authorize(fixture, contract) {
    await managed.authorizeDestination({
      account_id: fixture.accountId,
      destination_ref: fixture.destinationRef,
      generation: 1,
      authorized_at: fixture.now,
      ...(contract ? { pattern: 'file_transfer', transport: contract } : {}),
    });
  }

  /** Authorizes (recording `transport` unless `recorded === false`), binds, and commits one revision to deliver. */
  async function seedFeed(transport, { recorded = true } = {}) {
    const fixture = await seedConfiguration();
    await authorize(fixture, recorded ? transport : undefined);
    fixture.binding = bindingFor(fixture, { transport });
    await managed.installBinding(fixture.binding);
    const { suffix, accountId, now, period, configuration, canonicalization } = fixture;
    const obligation = {
      reporting_obligation_id: `obligation-router-${suffix}-1`,
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
      semanticFingerprint: `obligation-router-${suffix}-fingerprint`,
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({
      owner: `${suffix}-core-worker`,
      now,
      leaseMilliseconds: 600_000,
      account_id: accountId,
    });
    const rows = [{ media_buy_id: 'buy-2', impressions: 9 }];
    const controlTotals = [{ name: 'impressions', value: '9', value_type: 'integer', unit: 'impressions' }];
    const revisionId = `revision-router-${suffix}-1`;
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: revisionId,
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
    const contentSha = createHash('sha256').update(revisionBytes).digest('hex');
    const revision = {
      reporting_revision_id: revisionId,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      kind: 'snapshot',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-router-${suffix}-1`,
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: contentSha,
        byteCount: revisionBytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: now,
      dataThrough: period.end,
      sourceReadCutoffAt: now,
      createdAt: now,
      wireRevision: {
        reporting_revision_id: revisionId,
        revision_content_sha256: contentSha,
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
    fixture.revision = revision;
    return fixture;
  }

  function outcomeFor(fixture) {
    return {
      status: 'available',
      resource: {
        resource_ref: `resource-router-${fixture.suffix}`,
        kind: 'manifest',
        location: `reports/${fixture.revision.reporting_revision_id}/manifest.json`,
        manifest_version: '1.0',
        manifest_sha256: 'f'.repeat(64),
        immutability: 'immutable_location',
        expires_at: new Date(Date.parse(fixture.now) + 31 * 86_400_000).toISOString(),
      },
      verification: {
        verified_at: new Date().toISOString(),
        verification_path: 'representative_consumer',
        verification_profile: 'canonical_digest',
        row_count: 1,
        control_totals: fixture.revision.wireRevision.control_totals,
        physical_checksums: [{ object_ref: 'rows.json', algorithm: 'sha256', value: '7'.repeat(64) }],
        canonical_content_digest: fixture.revision.wireRevision.canonical_content_digest,
      },
    };
  }

  /**
   * A route adapter with the fence contract: revoke tombstones the generation,
   * and a write under a tombstoned generation is refused. `failures` makes the
   * first N deliveries throw, to exercise retries.
   */
  function fencedAdapter(name, feeds, { failures = 0 } = {}) {
    const tombstones = new Set();
    const writes = [];
    const calls = { deliver: 0, read: 0, revoke: 0 };
    const key = value =>
      `${value.account_id}:${value.destination_ref}:${value.authorization_generation ?? value.generation}`;
    const fixtureFor = binding => feeds().find(feed => feed.accountId === binding.account_id);
    let remainingFailures = failures;
    return {
      name,
      calls,
      writes,
      tombstones,
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async input => {
        calls.deliver += 1;
        if (tombstones.has(key(input.binding))) throw new Error(`${name}: generation is revoked`);
        if (remainingFailures === 'always' || remainingFailures > 0) {
          if (remainingFailures !== 'always') remainingFailures -= 1;
          throw new Error(`${name}: provider unavailable`);
        }
        writes.push(key(input.binding));
        return outcomeFor(fixtureFor(input.binding));
      },
      read: async () => {
        calls.read += 1;
        return Buffer.from(name);
      },
      revoke: async input => {
        calls.revoke += 1;
        tombstones.add(key(input.authorization));
      },
    };
  }

  function offering(transport) {
    return {
      offering_id: `router-${transport}-v1`,
      feed_purpose: 'analytics',
      report_definition_id: 'analytics-v1',
      report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
      report_definition_sha256: 'd'.repeat(64),
      reporting_profile: {
        id: 'analytics-v1',
        version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: 'e'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        grain: 'media_buy/day',
        primary_keys: ['media_buy_id'],
      },
      schedule: { period_duration: 'PT30M', alignment: 'utc', delivery_sla: 'PT0S' },
      supported_finality: ['snapshot'],
      reconciliation_mode: 'delivery_only',
      method: {
        pattern: 'file_transfer',
        transport,
        orchestration: 'producer_managed',
        destination_modes: ['existing'],
        provider: { domain: 'fixture.example' },
        format: 'jsonl',
      },
    };
  }

  /** A runtime over its own store instance, so one test's admission never leaks into another's. */
  async function runtimeFor(adapter, transports = ['gcs', 's3']) {
    const store = new ledger.PostgresReportingManagedDeliveryStore(pool);
    const runtime = await ledger.createReportingManagedDeliveryRuntime({
      coreStore: core,
      store,
      adapter,
      offerings: transports.map(offering),
      ...RUNTIME_POLICY,
    });
    return { store, runtime };
  }

  const materializations = async accountId =>
    (
      await pool.query(
        `SELECT attempt, status FROM adcp_reporting_materializations WHERE account_id = $1 ORDER BY attempt`,
        [accountId]
      )
    ).rows.map(row => [row.attempt, row.status]);

  const revocationRow = async fixture =>
    (
      await pool.query(
        `SELECT cleanup_completed_at, cleanup_lease_owner FROM adcp_reporting_destination_authorizations
          WHERE account_id = $1 AND destination_ref = $2 AND generation = 1`,
        [fixture.accountId, fixture.destinationRef]
      )
    ).rows[0];

  // ---- install-time admission ---------------------------------------------

  test('installBinding admits a binding only if its route exists and can verify its profile', async () => {
    const gcs = fencedAdapter('gcs', () => []);
    const s3 = { ...fencedAdapter('s3', () => []), verificationProfiles: ['manifest_checksums'] };
    const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
      routes: [
        { id: 'gcs', match: { pattern: 'file_transfer', transport: 'gcs' }, adapter: gcs },
        { id: 's3', match: { pattern: 'file_transfer', transport: 's3' }, adapter: s3 },
      ],
    });
    const { store } = await runtimeFor(router);

    const unsupportedProfile = await seedConfiguration();
    await authorize(unsupportedProfile, 's3');
    await assert.rejects(
      () =>
        store.installBinding(
          bindingFor(unsupportedProfile, { transport: 's3', verification_profile: 'canonical_digest' })
        ),
      error => {
        assert.ok(
          error instanceof ledger.ReportingManagedDeliveryRoutingErrorV1,
          'the typed error reaches the caller unwrapped'
        );
        assert.equal(error.code, 'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED');
        return true;
      }
    );
    assert.deepEqual(
      await store.installBinding(
        bindingFor(unsupportedProfile, { transport: 's3', verification_profile: 'manifest_checksums' })
      ),
      { inserted: true }
    );

    const missingRoute = await seedConfiguration();
    await authorize(missingRoute, 'azure_blob');
    await assert.rejects(
      () => store.installBinding(bindingFor(missingRoute, { transport: 'azure_blob' })),
      error => error.code === 'REPORTING_ROUTE_NOT_FOUND'
    );
    const refused = await pool.query('SELECT 1 FROM adcp_reporting_managed_bindings WHERE configuration_id = $1', [
      missingRoute.configuration.configurationId,
    ]);
    assert.equal(refused.rowCount, 0, 'a refused binding writes nothing');

    const supported = await seedConfiguration();
    await authorize(supported, 'gcs');
    assert.deepEqual(await store.installBinding(bindingFor(supported, { transport: 'gcs' })), { inserted: true });
    assert.equal(gcs.calls.deliver + s3.calls.deliver, 0, 'admission performs no provider I/O');
  });

  test('a runtime with a single adapter leaves binding installation as it was', async () => {
    const single = fencedAdapter('single', () => []);
    const { store } = await runtimeFor(single, ['anything_goes']);
    const fixture = await seedConfiguration();
    await authorize(fixture, 'whatever');
    assert.deepEqual(await store.installBinding(bindingFor(fixture, { transport: 'whatever' })), { inserted: true });
  });

  // ---- delivery, revocation and fencing -----------------------------------

  test('delivers and revokes each binding through its own route, and a late write is fenced on both', async () => {
    const feeds = [];
    const gcs = fencedAdapter('gcs', () => feeds);
    const s3 = fencedAdapter('s3', () => feeds);
    const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
      routes: [
        { id: 'gcs', match: { pattern: 'file_transfer', transport: 'gcs' }, adapter: gcs },
        { id: 's3', match: { pattern: 'file_transfer', transport: 's3' }, adapter: s3 },
      ],
    });
    const gcsFeed = await seedFeed('gcs');
    const s3Feed = await seedFeed('s3');
    feeds.push(gcsFeed, s3Feed);
    const { store, runtime } = await runtimeFor(router);

    const gcsRun = await runtime.runWorker({ account_id: gcsFeed.accountId });
    assert.equal(gcsRun.delivered, 1);
    assert.deepEqual(gcsRun.deliveriesByRoute, { gcs: 1 });
    assert.deepEqual([gcs.calls.deliver, s3.calls.deliver], [1, 0]);
    const s3Run = await runtime.runWorker({ account_id: s3Feed.accountId });
    assert.deepEqual(s3Run.deliveriesByRoute, { s3: 1 });
    assert.deepEqual([gcs.calls.deliver, s3.calls.deliver], [1, 1]);
    assert.deepEqual(gcs.writes, [`${gcsFeed.accountId}:${gcsFeed.destinationRef}:1`]);
    assert.deepEqual(s3.writes, [`${s3Feed.accountId}:${s3Feed.destinationRef}:1`]);

    // A retained resource is read back through the route that holds it.
    const gcsResource = (
      await pool.query(
        `SELECT data->'resource'->>'resource_ref' AS ref FROM adcp_reporting_materializations WHERE account_id = $1`,
        [gcsFeed.accountId]
      )
    ).rows[0].ref;
    assert.equal(
      Buffer.from(await runtime.readResource({ account_id: gcsFeed.accountId, resource_ref: gcsResource })).toString(),
      'gcs'
    );
    assert.equal(s3.calls.read, 0);

    for (const [feed, own, other, id] of [
      [gcsFeed, gcs, s3, 'gcs'],
      [s3Feed, s3, gcs, 's3'],
    ]) {
      assert.equal(
        await store.revokeDestination({
          account_id: feed.accountId,
          destination_ref: feed.destinationRef,
          generation: 1,
          revoked_at: new Date().toISOString(),
        }),
        true
      );
      const before = { own: own.calls.revoke, other: other.calls.revoke };
      const run = await runtime.runWorker({ account_id: feed.accountId });
      assert.deepEqual(
        run.revocationsByRoute,
        { [id]: 1 },
        `${id}: revoked through the route recorded on the authorization`
      );
      assert.equal(own.calls.revoke, before.own + 1);
      assert.equal(other.calls.revoke, before.other, `${id}: no other route was asked`);
      assert.equal((await revocationRow(feed)).cleanup_completed_at !== null, true);

      // A late write under the revoked generation is refused by the route's own fence...
      const lateWrites = own.writes.length;
      await assert.rejects(
        () =>
          router.deliver(
            {
              materialization: { reporting_materialization_id: 'late' },
              binding: feed.binding,
              obligation: {},
              revision: {},
              maxBytes: 1024,
            },
            { signal: new AbortController().signal }
          ),
        /generation is revoked/
      );
      assert.equal(own.writes.length, lateWrites, `${id}: nothing was written after revocation`);
      assert.equal(
        other.tombstones.has(`${feed.accountId}:${feed.destinationRef}:1`),
        false,
        `${id}: only its own route holds the tombstone`
      );
    }
    assert.equal(gcs.tombstones.has(`${s3Feed.accountId}:${s3Feed.destinationRef}:1`), false);
    assert.equal(s3.tombstones.has(`${gcsFeed.accountId}:${gcsFeed.destinationRef}:1`), false);
  });

  test('settlement is fenced by the store when authorization is revoked during a route delivery', async () => {
    const feeds = [];
    const feed = await seedFeed('s3');
    feeds.push(feed);
    let revokeMidDelivery;
    const s3 = fencedAdapter('s3', () => feeds);
    const deliver = s3.deliver;
    s3.deliver = async input => {
      const outcome = await deliver(input);
      await revokeMidDelivery();
      return outcome;
    };
    const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
      routes: [
        {
          id: 'gcs',
          match: { pattern: 'file_transfer', transport: 'gcs' },
          adapter: fencedAdapter('gcs', () => feeds),
        },
        { id: 's3', match: { pattern: 'file_transfer', transport: 's3' }, adapter: s3 },
      ],
    });
    const { store, runtime } = await runtimeFor(router);
    revokeMidDelivery = () =>
      store.revokeDestination({
        account_id: feed.accountId,
        destination_ref: feed.destinationRef,
        generation: 1,
        revoked_at: new Date().toISOString(),
      });
    const run = await runtime.runWorker({ account_id: feed.accountId });
    assert.equal(run.delivered, 0, 'a delivery that finished after revocation is not published');
    assert.deepEqual(await materializations(feed.accountId), [[1, 'failed']]);
  });

  // ---- legacy authorizations ----------------------------------------------

  test('a legacy authorization with no recorded contract fails revocation without a legacyDefault, then completes with one', async () => {
    const feeds = [];
    const gcs = fencedAdapter('gcs', () => feeds);
    const s3 = fencedAdapter('s3', () => feeds);
    const routes = [
      { id: 'gcs', match: { pattern: 'file_transfer', transport: 'gcs' }, adapter: gcs },
      { id: 's3', match: { pattern: 'file_transfer', transport: 's3' }, adapter: s3 },
    ];
    const legacy = await seedFeed('gcs', { recorded: false });
    feeds.push(legacy);
    assert.equal(
      (
        await pool.query(`SELECT transport FROM adcp_reporting_destination_authorizations WHERE account_id = $1`, [
          legacy.accountId,
        ])
      ).rows[0].transport,
      null
    );
    const strict = await runtimeFor(ledger.createReportingManagedDeliveryAdapterRouterV1({ routes }));
    await strict.store.revokeDestination({
      account_id: legacy.accountId,
      destination_ref: legacy.destinationRef,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });

    // Window 0 makes the grant overdue the moment it is claimed.
    const failed = await strict.runtime.runWorker({ account_id: legacy.accountId, authorizationRevocationSeconds: 0 });
    assert.equal(failed.revocationsCompleted, 0);
    assert.deepEqual(failed.revocationFailuresByRoute, { [ledger.UNROUTED_REPORTING_ROUTE_KEY_V1]: 1 });
    assert.deepEqual(failed.overdueByRoute, { [ledger.UNROUTED_REPORTING_ROUTE_KEY_V1]: 1 });
    assert.equal(failed.revocationsOverdue, 1, 'the store keeps counting it as overdue');
    assert.deepEqual([gcs.calls.revoke, s3.calls.revoke], [0, 0], 'no route was asked, and none guessed');
    assert.equal((await revocationRow(legacy)).cleanup_completed_at, null, 'the grant stays queued for retry');

    // Clear the retry backoff, then the same grant is taken by a router that names a legacy route.
    await pool.query(
      `UPDATE adcp_reporting_destination_authorizations SET cleanup_lease_expires_at = NULL, cleanup_lease_owner = NULL
        WHERE account_id = $1`,
      [legacy.accountId]
    );
    const lenient = await runtimeFor(
      ledger.createReportingManagedDeliveryAdapterRouterV1({ routes, legacyDefault: 'gcs' })
    );
    const completed = await lenient.runtime.runWorker({ account_id: legacy.accountId });
    assert.deepEqual(completed.revocationsByRoute, { gcs: 1 });
    assert.deepEqual([gcs.calls.revoke, s3.calls.revoke], [1, 0]);
    assert.notEqual((await revocationRow(legacy)).cleanup_completed_at, null);
  });

  // ---- retry accounting ---------------------------------------------------

  test('retries and the attempt cap are counted per materialization, whichever route serves it', async () => {
    const feeds = [];
    const gcs = fencedAdapter('gcs', () => feeds, { failures: 'always' });
    const s3 = fencedAdapter('s3', () => feeds, { failures: 2 });
    const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
      routes: [
        { id: 'gcs', match: { pattern: 'file_transfer', transport: 'gcs' }, adapter: gcs },
        { id: 's3', match: { pattern: 'file_transfer', transport: 's3' }, adapter: s3 },
      ],
    });
    const gcsFeed = await seedFeed('gcs');
    const s3Feed = await seedFeed('s3');
    feeds.push(gcsFeed, s3Feed);
    const { runtime } = await runtimeFor(router);

    const failuresByRoute = { gcs: 0, s3: 0 };
    const deliveriesByRoute = { gcs: 0, s3: 0 };
    for (let tick = 0; tick < 8; tick += 1) {
      for (const [id, feed] of [
        ['gcs', gcsFeed],
        ['s3', s3Feed],
      ]) {
        const run = await runtime.runWorker({ account_id: feed.accountId });
        failuresByRoute[id] += run.deliveryFailuresByRoute?.[id] ?? 0;
        deliveriesByRoute[id] += run.deliveriesByRoute?.[id] ?? 0;
      }
    }
    assert.deepEqual(
      await materializations(gcsFeed.accountId),
      [
        [1, 'failed'],
        [2, 'failed'],
        [3, 'failed'],
        [4, 'failed'],
        [5, 'failed'],
      ],
      'the failing route stops at the attempt cap and is never retried past it'
    );
    assert.deepEqual(await materializations(s3Feed.accountId), [
      [1, 'failed'],
      [2, 'failed'],
      [3, 'available'],
    ]);
    assert.equal(gcs.calls.deliver, 5);
    assert.equal(s3.calls.deliver, 3);
    assert.deepEqual(failuresByRoute, { gcs: 5, s3: 2 });
    assert.deepEqual(deliveriesByRoute, { gcs: 0, s3: 1 });
  });
});
