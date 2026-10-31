/**
 * Receipts for subscription obligations on PostgreSQL (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3): only the owning principal may file one, and a
 * refused receipt reads exactly like an unknown reference. Account obligations stay open to every
 * consumer of the account. Who reaches the handler at all is the host's account resolution and
 * grant (`allowed_tasks`); there is no post-revocation window.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const A = { tenantId: 'tenant-1', principalId: 'principal-a' };
const B = { tenantId: 'tenant-1', principalId: 'principal-b' };

describe('PostgreSQL subscription receipts', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_subscription_receipts_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let core;
  let managed;
  let canonicalize;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    canonicalize = require('@adcp/sdk').canonicalize;
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    core = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, managedDelivery: true });
    managed = new ledger.PostgresReportingManagedDeliveryStore(pool);
  });

  after(async () => {
    await pool?.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  /** One delivered consumer-receipt revision, owned by `owner` (or an account obligation). */
  async function seed(suffix, owner) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 10_800_000).toISOString(),
      end: new Date(nowMs - 9_000_000).toISOString(),
    };
    const accountId = `account-receipts-${suffix}`;
    const subscription = owner
      ? { ...owner, subscriptionId: `${suffix}-files`, offeringId: `${suffix}-files-v1`, ownership: 'owed_set' }
      : undefined;
    const configuration = {
      configurationId: `configuration-receipts-${suffix}`,
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
      mediaBuyIds: owner ? [] : ['buy-3'],
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
      semanticFingerprint: `configuration-receipts-${suffix}-fingerprint`,
      ...(subscription ? { subscription } : {}),
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: `destination-${suffix}`,
      generation: 1,
      authorized_at: now,
    });
    await managed.installBinding(
      ledger.reportingManagedDeliveryBindingV1({
        configurationId: configuration.configurationId,
        account_id: accountId,
        delivery_config_id: configuration.delivery_config_id,
        delivery_config_version: 1,
        destination_ref: `destination-${suffix}`,
        authorization_generation: 1,
        feed_purpose: 'analytics',
        method: 'file_transfer',
        transport: 'fixture_object_store',
        verification_profile: 'canonical_digest',
        reconciliation_mode: 'consumer_receipt',
        resource_retention_days: 30,
        created_at: now,
      })
    );
    const obligation = {
      reporting_obligation_id: `obligation-receipts-${suffix}`,
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
      semanticFingerprint: `obligation-receipts-${suffix}-fingerprint`,
      createdAt: now,
      ...(subscription ? { subscription } : {}),
    };
    await core.putObligation(obligation);
    const lease = await core.claimObligation({
      owner: `${suffix}-worker`,
      now,
      leaseMilliseconds: 600_000,
      account_id: accountId,
    });
    const rows = [{ media_buy_id: 'buy-3', impressions: 4 }];
    const controlTotals = [{ name: 'impressions', value: '4', value_type: 'integer', unit: 'impressions' }];
    const revisionId = `revision-receipts-${suffix}`;
    const bytes = Buffer.from(
      canonicalize({
        reporting_revision_id: revisionId,
        row_count: 1,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const sha = createHash('sha256').update(bytes).digest('hex');
    const digest = {
      algorithm: 'sha256',
      value: '6'.repeat(64),
      canonicalization_id: 'analytics-rows-v1',
      canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
      canonicalization_sha256: 'c'.repeat(64),
    };
    const revision = {
      reporting_revision_id: revisionId,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-receipts-${suffix}`,
      binding: { algorithm: 'rfc8785_jcs_v1', sha256: sha, byteCount: bytes.byteLength, rowCount: 1 },
      rows,
      observedAt: now,
      dataThrough: period.end,
      sourceReadCutoffAt: now,
      createdAt: now,
      wireRevision: {
        reporting_revision_id: revisionId,
        revision_content_sha256: sha,
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
    await core.commitRevision(revision, lease);
    await managed.planMaterializations({ account_id: accountId });
    await ledger.runManagedDeliveryWorker(
      managed,
      {
        verificationProfiles: ['canonical_digest'],
        revocationFencesDeliveryGenerations: true,
        deliver: async () => ({
          status: 'available',
          resource: {
            resource_ref: `resource-${suffix}`,
            kind: 'manifest',
            location: `reports/${revisionId}/manifest.json`,
            manifest_version: '1.0',
            manifest_sha256: 'f'.repeat(64),
            immutability: 'immutable_location',
            expires_at: new Date(Date.now() + 31 * 86_400_000).toISOString(),
          },
          verification: {
            verified_at: new Date().toISOString(),
            verification_path: 'representative_consumer',
            verification_profile: 'canonical_digest',
            row_count: 1,
            control_totals: controlTotals,
            physical_checksums: [{ object_ref: 'rows.json', algorithm: 'sha256', value: '7'.repeat(64) }],
            canonical_content_digest: digest,
          },
        }),
        read: async () => Buffer.from(''),
        revoke: async () => {},
      },
      { maxIterations: 2, account_id: accountId }
    );
    const materialization = (
      await pool.query(
        `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
        [obligation.reporting_obligation_id]
      )
    ).rows[0].data;
    return { accountId, now, obligation, revision, materialization, digest };
  }

  function receipt(fixture, id) {
    return {
      reporting_receipt_id: id,
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      reporting_revision_id: fixture.revision.reporting_revision_id,
      reporting_materialization_id: fixture.materialization.reporting_materialization_id,
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 1,
      observed_control_totals: fixture.revision.wireRevision.control_totals,
      observed_canonical_content_digest: fixture.revision.wireRevision.canonical_content_digest,
      observed_manifest_sha256: fixture.materialization.resource.manifest_sha256,
      observed_at: new Date().toISOString(),
    };
  }

  const handler = ledger =>
    ledger.createSyncReportingReceiptsHandler(managed, context => context.principal.principalId, undefined, {
      resolveSubscriptionPrincipal: context => context.principal,
    });
  const submit = async (fixture, principal, account, id) =>
    (
      await handler(ledger)(
        { idempotency_key: `receipt-batch-${id}`, receipts: [receipt(fixture, id)] },
        { account, principal }
      )
    ).results[0];
  const account = fixture => ({ id: fixture.accountId });
  test('only the owning principal may file a receipt for a subscription obligation', async () => {
    const owned = await seed('owned', A);
    const foreign = await submit(owned, B, account(owned), 'receipt-owned-foreign-1');
    assert.equal(foreign.result, 'failed', JSON.stringify(foreign));
    assert.equal(foreign.errors[0].code, 'INVALID_REQUEST', 'a foreign owner reads like an unknown reference');
    const own = await submit(owned, A, account(owned), 'receipt-owned-owner-01');
    assert.equal(own.result, 'recorded', JSON.stringify(own));
    // An account obligation stays open to every consumer of the account.
    const shared = await seed('shared', undefined);
    const anyone = await submit(shared, B, account(shared), 'receipt-shared-anyone1');
    assert.equal(anyone.result, 'recorded', JSON.stringify(anyone));
  });
});
