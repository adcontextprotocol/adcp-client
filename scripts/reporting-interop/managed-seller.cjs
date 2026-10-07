'use strict';

// The pinned MCP wrapper supplies authentication, schema validation, readiness,
// and shutdown. This fixture supplies real PostgreSQL facts and file delivery.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ACCOUNT_ID = 'reporting_core_lab';
const CONSUMER_ID = 'https://buyer.example.test/adcp';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = ms => new Date(ms).toISOString();

async function createFixture(
  api,
  pool,
  { mode, adjustments = false, notificationActivityPort, gcs, zeroRows = false }
) {
  assert.ok(['managed', 'billing'].includes(mode));
  const billing = mode === 'billing';
  const root = path.resolve(process.env.REPORTING_INTEROP_DESTINATION);
  const fixtures = path.resolve(__dirname, '../../test/fixtures/reporting-interop');
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'evidence-v1.json')));
  const rows = fs
    .readFileSync(path.join(fixtures, 'resources/rows.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(row => JSON.parse(row));
  const revision = structuredClone(fixture.revision);
  revision.account_id = ACCOUNT_ID;
  if (gcs) {
    const base = `https://storage.googleapis.com/${gcs.bucket}/${gcs.contractPrefix}`;
    revision.schema_uri = base + 'row-schema.json';
    revision.report_definition_uri = base + 'report-definition.json';
    revision.canonical_content_digest.canonicalization_uri = base + 'canonicalization.json';
  }
  // Core configurations in this fixture freeze media-buy scope, without
  // package constituents. The revision must describe that exact same scope.
  revision.coverage.package_ids = [];
  revision.coverage.covered_package_ids = [];
  if (zeroRows) {
    rows.length = 0;
    revision.row_count = 0;
    revision.control_totals = revision.control_totals.map(total => ({ ...total, value: '0' }));
    revision.revision_content_sha256 = sha(
      Buffer.from(
        api.jcs.canonicalize({
          reporting_revision_id: revision.reporting_revision_id,
          row_count: 0,
          control_totals: revision.control_totals,
          reporting_rows: rows,
        })
      )
    );
    revision.canonical_content_digest.value = sha(Buffer.from('[]'));
  }
  if (!billing) delete revision.canonical_content_digest;
  // Keep the immutable historical report inside this invocation's recovery
  // window; PostgreSQL still supplies the authoritative current time.
  const recoverySeconds = Math.max(60, Math.ceil((Date.now() - Date.parse(revision.period.end)) / 1000) + 3600);
  const definition = JSON.parse(fs.readFileSync(path.join(fixtures, 'resources/report-definition.json')));
  const contracts = new Map();
  for (const [uri, name] of [
    [revision.schema_uri, 'row-schema.json'],
    [revision.report_definition_uri, 'report-definition.json'],
    [
      gcs
        ? `https://storage.googleapis.com/${gcs.bucket}/${gcs.contractPrefix}canonicalization.json`
        : fixture.revision.canonical_content_digest.canonicalization_uri,
      'canonicalization.json',
    ],
  ]) {
    const body = fs.readFileSync(path.join(fixtures, 'resources', name));
    contracts.set(uri, name);
    if (gcs)
      await gcs.storage
        .bucket(gcs.bucket)
        .file(gcs.contractPrefix + name)
        .save(body, {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType:
              name === 'report-definition.json'
                ? 'application/vnd.adcp.reporting-definition+json'
                : name === 'canonicalization.json'
                  ? 'application/vnd.adcp.reporting-canonicalization+json'
                  : 'application/schema+json',
          },
        });
    fs.mkdirSync(path.join(root, 'contracts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'contracts', name), body, { flag: 'wx' });
  }
  fs.writeFileSync(path.join(root, 'contracts.json'), JSON.stringify(Object.fromEntries(contracts)), { flag: 'wx' });
  const profile = billing ? 'canonical_digest' : 'manifest_checksums';
  const feed = billing ? 'billing' : 'analytics';
  const offering = {
    offering_id: `${mode}-files-v1`,
    feed_purpose: feed,
    report_definition_id: revision.report_definition_id,
    report_definition_uri: revision.report_definition_uri,
    report_definition_sha256: revision.report_definition_sha256,
    reporting_profile: {
      id: revision.reporting_profile,
      version: revision.schema_version,
      schema_uri: revision.schema_uri,
      schema_sha256: revision.schema_sha256,
      schema_dialect: revision.schema_dialect,
      schema_ref_policy: revision.schema_ref_policy,
      grain: definition.grain,
      primary_keys: ['media_buy_id', 'date'],
      ...(billing
        ? {
            canonicalization_id: revision.canonical_content_digest.canonicalization_id,
            canonicalization_contract_version: '1.0',
            canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
            canonicalization_uri: revision.canonical_content_digest.canonicalization_uri,
            canonicalization_sha256: revision.canonical_content_digest.canonicalization_sha256,
          }
        : {}),
    },
    schedule: { period_duration: 'P31D', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['official'],
    reconciliation_mode: billing ? 'consumer_receipt' : 'delivery_only',
    method: {
      pattern: 'file_transfer',
      transport: gcs ? 'gcs' : 'owned_files',
      orchestration: 'producer_managed',
      destination_modes: ['existing'],
      provider: { domain: gcs ? 'storage.googleapis.com' : 'reports.example.test' },
      format: 'jsonl',
    },
  };
  for (const migration of [
    api.ledger.REPORTING_LEDGER_MIGRATION,
    api.ledger.REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION,
    api.ledger.REPORTING_MANAGED_DELIVERY_MIGRATION,
    ...(gcs
      ? [api.ledger.REPORTING_OBJECT_WRITE_MIGRATION, api.ledger.REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION]
      : []),
  ]) {
    await pool.query(migration);
  }
  const core = new api.ledger.PostgresReportingLedgerStore(pool, {
    acknowledgeIsolatedDatabase: true,
    managedDelivery: true,
    notificationActivityPort,
  });
  const managed = new api.ledger.PostgresReportingManagedDeliveryStore(pool, {
    evidenceRetentionDays: 90,
    statusRetentionDays: 90,
  });
  const resources = new Map();
  const savedExpected = {
    deliveryConfigId: `${mode}-files`,
    deliveryConfigVersion: 1,
    reportDefinitionId: revision.report_definition_id,
    feedPurpose: feed,
    reportingProfile: revision.reporting_profile,
    mediaBuyIds: revision.media_buy_ids,
    destinationRef: `destination-${mode}`,
    deliveryMethod: 'file_transfer',
    requiredFinality: 'official',
    reconciliationMode: offering.reconciliation_mode,
    coverageRequirement: 'full',
    coverage: revision.coverage,
    reportDefinitionUri: revision.report_definition_uri,
    reportDefinitionSha256: revision.report_definition_sha256,
    schemaVersion: revision.schema_version,
    schemaUri: revision.schema_uri,
    schemaSha256: revision.schema_sha256,
    schemaDialect: revision.schema_dialect,
    schemaRefPolicy: revision.schema_ref_policy,
    verificationProfile: profile,
    periodStart: revision.period.start,
    periodEnd: revision.period.end,
    officialFinality: { policyId: revision.finality_policy_id, basis: revision.finality_basis },
    ...(billing
      ? {
          canonicalization: {
            id: revision.canonical_content_digest.canonicalization_id,
            uri: revision.canonical_content_digest.canonicalization_uri,
            sha256: revision.canonical_content_digest.canonicalization_sha256,
            primaryKeys: ['media_buy_id', 'date'],
          },
        }
      : {}),
  };
  const createGcsAdapter = options => {
    gcs.observeFactory?.(options);
    return gcs.api.createGcsReportingManagedDeliveryAdapterV1(options);
  };
  const adapter = gcs
    ? await createGcsAdapter({
        storage: gcs.storage,
        coreStore: core,
        store: managed,
        bucket: gcs.bucket,
        namespace: gcs.namespace,
        acknowledgeDedicatedFreshBucket: true,
        resolveExpectedPeriod: async () => structuredClone(savedExpected),
        resolveContractReader: async () => ({
          scope: {
            principal_id: 'fixture-producer',
            account_id: ACCOUNT_ID,
            destination_ref: `destination-${mode}`,
            generation: 1,
          },
          bucket: gcs.bucket,
          objectPrefix: gcs.contractPrefix,
          getStorage: async () => gcs.storage,
          authorize: async ({ scope, bucket, objectPrefix }, { signal }) => {
            signal.throwIfAborted();
            return (
              scope.principal_id === 'fixture-producer' &&
              scope.account_id === ACCOUNT_ID &&
              scope.destination_ref === `destination-${mode}` &&
              scope.generation === 1 &&
              bucket === gcs.bucket &&
              objectPrefix === gcs.contractPrefix &&
              (await managed.isAuthorizationCurrent(scope))
            );
          },
        }),
      })
    : {
        verificationProfiles: [profile],
        revocationFencesDeliveryGenerations: true,
        async deliver(input) {
          const id = input.materialization.reporting_materialization_id;
          assert.match(id, /^[A-Za-z0-9._-]+$/);
          const directory = path.join(root, id);
          fs.mkdirSync(directory);
          const bytes = Buffer.from(input.revision.rows.map(row => JSON.stringify(row)).join('\n') + '\n');
          fs.writeFileSync(path.join(directory, 'rows.jsonl'), bytes, { flag: 'wx' });
          const manifest = {
            ...JSON.parse(fs.readFileSync(path.join(fixtures, 'resources/manifest.json'))),
            reporting_revision_id: input.revision.reporting_revision_id,
            reporting_obligation_id: input.obligation.reporting_obligation_id,
            reporting_materialization_id: id,
            period: input.revision.wireRevision.period,
            files: [{ object_ref: 'rows.jsonl', size_bytes: bytes.length, sha256: sha(bytes), row_count: rows.length }],
            total_size_bytes: bytes.length,
            row_count: rows.length,
            control_totals: input.revision.wireRevision.control_totals,
            created_at: iso(Date.now()),
          };
          const manifestBytes = Buffer.from(api.jcs.canonicalize(manifest));
          fs.writeFileSync(path.join(directory, 'manifest.json'), manifestBytes, { flag: 'wx' });
          const resourceRef = `file:${id}`;
          resources.set(resourceRef, directory);
          return {
            status: 'available',
            resource: {
              resource_ref: resourceRef,
              kind: 'manifest',
              location: `https://reports.example.test/${id}/manifest.json`,
              manifest_version: '1.0',
              manifest_sha256: sha(manifestBytes),
              immutability: 'immutable_location',
              expires_at: iso(Date.now() + 31 * 86_400_000),
            },
            verification: {
              verified_at: iso(Date.now()),
              verification_path: 'representative_consumer',
              verification_profile: profile,
              row_count: rows.length,
              control_totals: input.revision.wireRevision.control_totals,
              physical_checksums: [{ object_ref: 'rows.jsonl', algorithm: 'sha256', value: sha(bytes) }],
              ...(billing ? { canonical_content_digest: input.revision.wireRevision.canonical_content_digest } : {}),
            },
          };
        },
        async read(input) {
          const directory = resources.get(input.resource.resource_ref);
          if (!directory) throw new Error('resource grant is unavailable');
          const body = fs.readFileSync(path.join(directory, 'manifest.json'));
          assert.ok(body.length <= input.maxBytes);
          return body;
        },
        async revoke() {
          for (const directory of resources.values()) fs.rmSync(directory, { recursive: true });
          resources.clear();
        },
      };
  if (gcs?.observeDelivery) {
    const deliver = adapter.deliver.bind(adapter);
    adapter.deliver = async (input, context) => {
      const outcome = await deliver(input, context);
      gcs.observeDelivery(structuredClone(input), structuredClone(outcome));
      return outcome;
    };
  }
  const runtime = await api.ledger.createReportingManagedDeliveryRuntime({
    coreStore: core,
    store: managed,
    offerings: [offering],
    automatedRecoveryWindowSeconds: recoverySeconds,
    statusRetentionDays: 90,
    resourceRetentionDays: 30,
    authorizationRevocationSeconds: 60,
    resolveConsumerId: context => context.consumer_id,
    adapter,
  });
  const context = { account: { account_id: ACCOUNT_ID }, consumer_id: CONSUMER_ID };
  let prepared = false;
  let materialization;
  let coreLease;
  let adjustmentNumber = 0;
  const configurationId = `configuration-${mode}`;
  const obligationId = `obligation-${mode}`;
  const destination = `destination-${mode}`;
  const status = (view = 'periods', extra = {}) =>
    runtime.getReportingStatus(
      {
        account: context.account,
        view,
        period: revision.period,
        ...extra,
      },
      context
    );
  async function prepare() {
    if (prepared) return;
    const now = iso(Date.now());
    const schedule = {
      anchor: revision.period.start,
      periodMilliseconds: Date.parse(revision.period.end) - Date.parse(revision.period.start),
      deliverySlaMilliseconds: 0,
      recoveryWindowMilliseconds: recoverySeconds * 1000,
    };
    const configuration = {
      configurationId,
      account: context.account,
      sourceScope: { warehouse: 'owned-file-fixture' },
      delivery_config_id: `${mode}-files`,
      delivery_config_version: 1,
      offeringId: offering.offering_id,
      report_definition_id: revision.report_definition_id,
      feedPurpose: feed,
      requiredFinality: 'official',
      ...(billing
        ? {
            canonicalization: {
              id: revision.canonical_content_digest.canonicalization_id,
              uri: revision.canonical_content_digest.canonicalization_uri,
              sha256: revision.canonical_content_digest.canonicalization_sha256,
              primaryKeys: ['media_buy_id', 'date'],
            },
          }
        : {}),
      requestedMetrics: ['impressions', 'spend'],
      requestedDimensions: ['media_buy_id', 'date'],
      constituents: [],
      mediaBuyIds: revision.media_buy_ids,
      sourceTimezone: 'UTC',
      schedule,
      sourceSettings: {},
      contract: { reportingProfile: revision.reporting_profile },
      installedAt: revision.period.start,
      semanticFingerprint: `configuration-${mode}-v1`,
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: ACCOUNT_ID,
      destination_ref: destination,
      generation: 1,
      authorized_at: now,
    });
    await managed.installBinding(
      api.ledger.reportingManagedDeliveryBindingV1({
        configurationId,
        account_id: ACCOUNT_ID,
        delivery_config_id: configuration.delivery_config_id,
        delivery_config_version: 1,
        destination_ref: destination,
        authorization_generation: 1,
        feed_purpose: feed,
        method: 'file_transfer',
        transport: gcs ? 'gcs' : 'owned_files',
        verification_profile: profile,
        reconciliation_mode: offering.reconciliation_mode,
        resource_retention_days: 30,
        created_at: now,
      })
    );
    const obligation = {
      reporting_obligation_id: obligationId,
      configurationId,
      account: context.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: offering.offering_id,
      report_definition_id: revision.report_definition_id,
      feedPurpose: feed,
      requiredFinality: 'official',
      periodOrdinal: 0,
      period: { start: revision.period.start, end: revision.period.end, sourceTimezone: 'UTC' },
      schedule,
      scopeResolvedAt: revision.period.end,
      coverage: {
        status: 'full',
        evaluatedAt: revision.period.end,
        mediaBuyIds: revision.media_buy_ids,
        fullyCoveredMediaBuyIds: revision.media_buy_ids,
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: configuration.requestedMetrics,
      requestedDimensions: configuration.requestedDimensions,
      constituents: [],
      mediaBuyIds: revision.media_buy_ids,
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: revision.period.end,
      recoveryDeadlineAt: iso(Date.parse(revision.period.end) + recoverySeconds * 1000),
      publicationOffsets: [],
      nextAttemptAt: revision.period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: `obligation-${mode}-v1`,
      createdAt: now,
    };
    await core.putObligation(obligation);
    const lease = await core.claimObligation({
      owner: 'interop-worker',
      now,
      leaseMilliseconds: adjustments ? 3_600_000 : 600_000,
      account_id: ACCOUNT_ID,
    });
    assert.ok(lease);
    coreLease = lease;
    const bytes = Buffer.from(
      api.jcs.canonicalize({
        reporting_revision_id: revision.reporting_revision_id,
        row_count: rows.length,
        control_totals: revision.control_totals,
        reporting_rows: rows,
      })
    );
    assert.equal(sha(bytes), revision.revision_content_sha256);
    await core.commitRevision(
      {
        reporting_revision_id: revision.reporting_revision_id,
        reporting_obligation_id: obligationId,
        revisionNumber: 1,
        finality: 'official',
        kind: 'official',
        manifest: { level: 'basic', objectRef: `${mode}-manifest`, sha256: sha(bytes), byteCount: bytes.length },
        sourcePublicationId: `${mode}-publication`,
        binding: { algorithm: 'rfc8785_jcs_v1', sha256: sha(bytes), byteCount: bytes.length, rowCount: rows.length },
        rows,
        observedAt: now,
        dataThrough: revision.period.end,
        sourceReadCutoffAt: now,
        createdAt: now,
        wireRevision: revision,
      },
      lease
    );
    const worker = await runtime.runWorker({ account_id: ACCOUNT_ID, maxIterations: 2 });
    assert.equal(
      worker.delivered,
      1,
      JSON.stringify({
        worker,
        status: await status('revision', { reporting_revision_id: revision.reporting_revision_id }),
      })
    );
    assert.equal(worker.failed, 0);
    materialization = (await status('revision', { reporting_revision_id: revision.reporting_revision_id }))
      .materializations[0];
    assert.equal(materialization.status, 'available');
    prepared = true;
  }
  async function appendAdjustments(ids) {
    assert.ok(billing && adjustments, 'adjustment controls require the billing fixture');
    await prepare();
    for (const id of ids) {
      const vector = fixture.adjustments.find(value => value.id === id);
      assert.ok(vector, 'unknown immutable adjustment vector');
      const wireAdjustment = structuredClone(vector.adjustment);
      const { canonical_adjustment_sha256, ...unsigned } = wireAdjustment;
      assert.equal(sha(Buffer.from(api.jcs.canonicalize(unsigned))), canonical_adjustment_sha256);
      const previous = (await core.listAdjustments(obligationId)).find(
        value => value.reporting_adjustment_id === wireAdjustment.reporting_adjustment_id
      );
      if (previous) {
        assert.deepEqual(previous.wireAdjustment, wireAdjustment);
        continue;
      }
      const bytes = Buffer.from(api.jcs.canonicalize([]));
      const manifest = Buffer.from(api.jcs.canonicalize(wireAdjustment));
      const committed = await core.commitAdjustment(
        {
          reporting_adjustment_id: wireAdjustment.reporting_adjustment_id,
          reporting_obligation_id: obligationId,
          adjusts_reporting_revision_id: revision.reporting_revision_id,
          adjustmentNumber: ++adjustmentNumber,
          manifest: {
            level: 'basic',
            objectRef: `adjustment-${id}`,
            sha256: sha(manifest),
            byteCount: manifest.length,
          },
          sourcePublicationId: `adjustment-publication-${id}`,
          binding: { algorithm: 'rfc8785_jcs_v1', sha256: sha(bytes), byteCount: bytes.length, rowCount: 0 },
          rows: [],
          observedAt: wireAdjustment.correction_observed_at,
          dataThrough: revision.period.end,
          sourceReadCutoffAt: wireAdjustment.correction_observed_at,
          createdAt: wireAdjustment.created_at,
          wireAdjustment,
        },
        coreLease
      );
      assert.equal(committed.value.reporting_adjustment_id, wireAdjustment.reporting_adjustment_id);
    }
  }
  async function controller(scenario, operation) {
    assert.equal(scenario, `reliable_reporting_${billing ? 'reconciled_billing' : 'managed_delivery'}_probe`);
    await prepare();
    if (operation === 'prepare')
      return {
        success: true,
        simulated: {
          reporting_revision_id: revision.reporting_revision_id,
          reporting_materialization_id: materialization.reporting_materialization_id,
        },
      };
    if (operation === 'revoke_access') {
      await managed.revokeDestination({
        account_id: ACCOUNT_ID,
        destination_ref: destination,
        generation: 1,
        revoked_at: iso(Date.now()),
      });
      const worker = await runtime.runWorker({ account_id: ACCOUNT_ID, maxIterations: 2 });
      assert.equal(worker.revocationsCompleted, 1);
      assert.equal(
        await runtime.readResource({ account_id: ACCOUNT_ID, resource_ref: materialization.resource.resource_ref }),
        null
      );
      return { success: true, simulated: { access_revoked: true, historical_metadata_retained: true } };
    }
    throw new Error('unsupported operation');
  }
  return { mode, runtime, controller, appendAdjustments, core, managed, adapter, savedExpected, status };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const upstream = argv[argv.indexOf('--upstream') + 1];
  const wrapper = require(
    path.join(path.resolve(upstream), 'scripts/ci/reporting_interop/ts_managed_reporting_server.cjs')
  );
  argv.push('--pg-url', process.env.DATABASE_URL);
  wrapper.main(argv, { createManagedReportingFixture: createFixture }).catch(error => {
    const identifier = value =>
      typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : undefined;
    console.error(
      JSON.stringify({ status: 'failed', error_type: identifier(error?.name), error_code: identifier(error?.code) })
    );
    process.exitCode = 1;
  });
}

module.exports = { createFixture };
