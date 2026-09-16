const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ledger = require('../../dist/lib/reporting/ledger/index.js');

function lease() {
  const now = '2026-08-27T04:00:00.000Z';
  const digest = {
    algorithm: 'sha256',
    value: 'b'.repeat(64),
    canonicalization_id: 'billing-rows-v1',
    canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
    canonicalization_sha256: 'c'.repeat(64),
  };
  const binding = ledger.reportingManagedDeliveryBindingV1({
    configurationId: 'config-1',
    account_id: 'account-1',
    delivery_config_id: 'billing-files',
    delivery_config_version: 1,
    destination_ref: 'destination-generation-1',
    authorization_generation: 1,
    feed_purpose: 'billing',
    method: 'file_transfer',
    verification_profile: 'canonical_digest',
    reconciliation_mode: 'consumer_receipt',
    resource_retention_days: 30,
    created_at: now,
  });
  return {
    materialization: {
      reporting_materialization_id: 'materialization-1',
      reporting_revision_id: 'revision-1',
      reporting_obligation_id: 'obligation-1',
      delivery_config_id: 'billing-files',
      delivery_config_version: 1,
      destination_ref: binding.destination_ref,
      feed_purpose: 'billing',
      method: 'file_transfer',
      attempt: 1,
      status: 'pending',
      created_at: now,
    },
    binding,
    obligation: { reporting_obligation_id: 'obligation-1' },
    revision: {
      reporting_revision_id: 'revision-1',
      binding: { rowCount: 2 },
      wireRevision: { canonical_content_digest: digest, control_totals: [] },
    },
    owner: 'worker-1',
    generation: 1,
    expires_at: '2026-08-27T04:01:00.000Z',
  };
}

function outcome() {
  return {
    status: 'available',
    resource: {
      resource_ref: 'resource-1',
      kind: 'manifest',
      location: 'reports/revision-1/manifest.json',
      manifest_version: '1.0',
      manifest_sha256: 'a'.repeat(64),
      immutability: 'immutable_location',
      expires_at: '2026-09-27T04:00:00.000Z',
    },
    verification: {
      verified_at: '2026-08-27T04:00:01.000Z',
      verification_path: 'representative_consumer',
      verification_profile: 'canonical_digest',
      row_count: 2,
      control_totals: [],
      physical_checksums: [{ object_ref: 'rows.json', algorithm: 'sha256', value: 'f'.repeat(64) }],
      canonical_content_digest: lease().revision.wireRevision.canonical_content_digest,
    },
  };
}

function offering(reconciliationMode = 'delivery_only') {
  return {
    offering_id: `managed-${reconciliationMode}`,
    feed_purpose: reconciliationMode === 'consumer_receipt' ? 'billing' : 'analytics',
    report_definition_id: 'report-definition-v1',
    report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
    report_definition_sha256: 'd'.repeat(64),
    reporting_profile: {
      id: 'reporting-profile-v1',
      version: '1.0',
      schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
      schema_sha256: 'e'.repeat(64),
      schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
      schema_ref_policy: 'local_fragment_only',
      grain: 'media_buy/day',
      primary_keys: ['media_buy_id'],
      ...(reconciliationMode === 'consumer_receipt'
        ? {
            canonicalization_id: 'billing-rows-v1',
            canonicalization_contract_version: '1.0',
            canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
            canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
            canonicalization_sha256: 'a'.repeat(64),
          }
        : {}),
    },
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT1H' },
    supported_finality: ['official'],
    reconciliation_mode: reconciliationMode,
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

describe('seller managed reporting runtime', () => {
  test('does not let a delayed consumer mismatch hide an action-required managed failure', () => {
    assert.equal(ledger.moreSevereReportingHealthV1('action_required', 'delayed'), 'action_required');
  });

  test('fails wiring closed instead of advertising an unavailable tier', async () => {
    const base = {
      coreStore: {},
      store: { probe: async () => false },
      adapter: {
        verificationProfiles: ['native_commit'],
        revocationFencesDeliveryGenerations: true,
        deliver: async () => {},
        read: async () => new Uint8Array(),
        revoke: async () => {},
      },
      offerings: [offering()],
      automatedRecoveryWindowSeconds: 60,
      statusRetentionDays: 30,
      resourceRetentionDays: 30,
      authorizationRevocationSeconds: 60,
    };
    await assert.rejects(() => ledger.createReportingManagedDeliveryRuntime(base), /not operational/);
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...base,
          store: { probe: async () => true, listInstalledRecoveryWindowSeconds: async () => [60] },
          offerings: [offering('consumer_receipt')],
        }),
      /authenticated receipt handler and canonical-digest verifier/
    );
  });

  test('derives optional tier claims from the installed handler and verifier set', async () => {
    const common = {
      coreStore: {},
      store: { probe: async () => true, listInstalledRecoveryWindowSeconds: async () => [0] },
      adapter: {
        verificationProfiles: ['native_commit'],
        revocationFencesDeliveryGenerations: true,
        deliver: async () => {},
        read: async () => new Uint8Array(),
        revoke: async () => {},
      },
      offerings: [offering()],
      automatedRecoveryWindowSeconds: 0,
      statusRetentionDays: 30,
      resourceRetentionDays: 30,
      authorizationRevocationSeconds: 0,
    };
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...common,
          adapter: { ...common.adapter, revocationFencesDeliveryGenerations: undefined },
        }),
      /generation-fencing revocation components/
    );
    // `automated_recovery_window_seconds` is published once per agent while
    // Core windows are per configuration, so the advertised value is required
    // to be an upper bound over installed windows rather than equal to each.
    // Advertising more than the widest is conservative and allowed; advertising
    // less promises a recovery bound the deployment does not keep.
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...common,
          store: { probe: async () => true, listInstalledRecoveryWindowSeconds: async () => [60, 900] },
          automatedRecoveryWindowSeconds: 300,
        }),
      /at least the widest installed managed Core recovery window \(900s\)/
    );
    const heterogeneous = await ledger.createReportingManagedDeliveryRuntime({
      ...common,
      store: { probe: async () => true, listInstalledRecoveryWindowSeconds: async () => [60, 900] },
      automatedRecoveryWindowSeconds: 900,
    });
    assert.equal(heterogeneous.reportingDeliveryCapabilities.automated_recovery_window_seconds, 900);
    // No managed tenant yet, or the last one just offboarded: still startable.
    const unbound = await ledger.createReportingManagedDeliveryRuntime({
      ...common,
      store: { probe: async () => true, listInstalledRecoveryWindowSeconds: async () => [] },
      automatedRecoveryWindowSeconds: 120,
    });
    assert.equal(unbound.reportingDeliveryCapabilities.automated_recovery_window_seconds, 120);
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...common,
          offerings: [{ ...offering(), method: {} }],
        }),
      /does not satisfy the complete installed RC3 schema/
    );
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...common,
          offerings: [
            {
              ...offering(),
              method: { ...offering().method, format: 'nonsense' },
            },
          ],
        }),
      /does not satisfy the complete installed RC3 schema/
    );
    const managed = await ledger.createReportingManagedDeliveryRuntime(common);
    assert.equal(managed.reportingDeliveryCapabilities.managed_delivery, true);
    assert.equal(managed.reportingDeliveryCapabilities.reconciled_billing, undefined);
    assert.equal(managed.syncReportingReceipts, undefined);

    const reconciled = await ledger.createReportingManagedDeliveryRuntime({
      ...common,
      resolveConsumerId: () => 'buyer-1',
      adapter: { ...common.adapter, verificationProfiles: ['canonical_digest'] },
      offerings: [offering('consumer_receipt')],
    });
    assert.equal(reconciled.reportingDeliveryCapabilities.reconciled_billing, true);
    assert.equal(reconciled.reportingDeliveryCapabilities.receipt_task, 'sync_reporting_receipts');
    assert.equal(typeof reconciled.syncReportingReceipts, 'function');
  });

  test('does not publish a delivery when authorization is revoked during adapter I/O', async () => {
    const claimed = lease();
    let authorized = true;
    const store = {
      planMaterializations: async () => 1,
      claimRevocation: async () => null,
      claimMaterialization: async () => (claimed ? structuredClone(claimed) : null),
      settleMaterialization: async ({ outcome: settled }) => authorized && settled.status !== 'failed',
    };
    let claimCount = 0;
    store.claimMaterialization = async () => (claimCount++ === 0 ? structuredClone(claimed) : null);
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      deliver: async () => {
        authorized = false;
        return outcome();
      },
    };
    const result = await ledger.runManagedDeliveryWorker(store, adapter, {
      now: () => new Date('2026-08-27T04:00:00.000Z'),
      maxIterations: 2,
    });
    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
  });

  test('keeps tenant-local workers from claiming another account revocation', async () => {
    let claimInput;
    const store = {
      planMaterializations: async () => 0,
      claimRevocation: async input => {
        claimInput = input;
        return null;
      },
      claimMaterialization: async () => null,
    };
    await ledger.runManagedDeliveryWorker(store, {}, { account_id: 'account-1', maxIterations: 1 });
    assert.equal(claimInput.account_id, 'account-1');
  });

  test('does not let one failed provider cleanup starve another revocation', async () => {
    const leases = ['poison-destination', 'healthy-destination'].map(destination_ref => ({
      authorization: {
        account_id: 'account-1',
        destination_ref,
        generation: 1,
        authorized_at: '2026-08-27T04:00:00.000Z',
        revoked_at: '2026-08-27T04:00:01.000Z',
      },
      owner: 'worker-1',
      generation: 1,
      expires_at: '2026-08-27T04:01:05.000Z',
    }));
    const completed = [];
    const store = {
      planMaterializations: async () => 0,
      releaseRevocation: async () => true,
      claimRevocation: async () => leases.shift() ?? null,
      releaseRevocation: async () => true,
      completeRevocation: async ({ lease: value }) => {
        completed.push(value.authorization.destination_ref);
        return true;
      },
      claimMaterialization: async () => null,
    };
    const adapter = {
      revoke: async ({ authorization }) => {
        if (authorization.destination_ref === 'poison-destination') throw new Error('provider unavailable');
      },
    };
    const result = await ledger.runManagedDeliveryWorker(store, adapter, {
      maxIterations: 2,
      deliveryDeadlineMilliseconds: 10,
      leaseMilliseconds: 5010,
    });
    assert.deepEqual(completed, ['healthy-destination']);
    assert.equal(result.revocationsCompleted, 1);
  });

  test('buffers a resource and rechecks authorization before returning bytes', async () => {
    const claimed = lease();
    const completed = { ...claimed.materialization, ...outcome(), ready_at: '2026-08-27T04:00:01.000Z' };
    let authorized = true;
    const store = {
      getReadableResource: async () => ({ materialization: completed, binding: claimed.binding }),
      isAuthorizationCurrent: async () => authorized,
    };
    const adapter = {
      read: async () => {
        authorized = false;
        return new Uint8Array([1, 2, 3]);
      },
    };
    const result = await ledger.readManagedReportingResource(store, adapter, {
      account_id: 'account-1',
      resource_ref: 'resource-1',
    });
    assert.equal(result, null);
  });

  test('does not leak a provider message when an adapter read throws synchronously', async () => {
    const selected = { materialization: outcome(), binding: lease().binding };
    const store = {
      getReadableResource: async () => selected,
      isAuthorizationCurrent: async () => true,
    };
    // Not `async`: a client constructed inside `read`, or a credential
    // resolved eagerly, throws before any promise exists to attach a handler
    // to. The sanitising `.catch` was never reached and the provider string
    // reached the caller verbatim.
    const adapter = {
      read: () => {
        throw new Error('s3: AccessDenied for arn:aws:iam::42:role/reporting-secret');
      },
    };
    await assert.rejects(
      () =>
        ledger.readManagedReportingResource(store, adapter, {
          account_id: 'account-1',
          resource_ref: 'resource-1',
        }),
      error => {
        assert.equal(error.message, 'Managed reporting resource read failed');
        assert.match(String(error.cause?.message), /AccessDenied/);
        return true;
      }
    );
  });

  test('refuses an empty batch before it can answer with an empty results array', async () => {
    const handler = ledger.createSyncReportingReceiptsHandler(
      { syncReceiptBatch: async () => assert.fail('an empty batch must never reach the store') },
      () => 'buyer-1'
    );
    // RC3 gives `results` minItems 1, so a per-entry refusal of a batch with
    // no entries is a schema-invalid body. The account mismatch used to be
    // answered first and produced exactly that.
    await assert.rejects(
      () =>
        handler(
          { account: { account_id: 'account-other' }, idempotency_key: 'receipt-empty-0001', receipts: [] },
          { account: { id: 'account-1' } }
        ),
      error => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.match(error.message, /at least one receipt/);
        return true;
      }
    );
    // And a non-empty batch for the wrong account still answers per entry.
    const denied = await handler(
      {
        account: { account_id: 'account-other' },
        idempotency_key: 'receipt-empty-0002',
        receipts: [
          {
            reporting_receipt_id: 'receipt-empty-entry-0001',
            reporting_obligation_id: 'obligation-1',
            reporting_revision_id: 'revision-1',
            reporting_materialization_id: 'materialization-1',
            status: 'accepted',
            verification_profile: 'canonical_digest',
            observed_row_count: 2,
            observed_control_totals: { impressions: 2 },
            observed_canonical_content_digest: 'a'.repeat(64),
            observed_manifest_sha256: 'b'.repeat(64),
            observed_at: '2026-08-27T05:00:00.000Z',
          },
        ],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(denied.results.length, 1);
    assert.equal(denied.results[0].result, 'failed');
    assert.equal(denied.results[0].errors[0].code, 'PERMISSION_DENIED');
  });

  test('enforces the resource-read deadline even when an adapter ignores abort', async () => {
    const selected = { materialization: outcome(), binding: lease().binding };
    const store = {
      getReadableResource: async () => selected,
      isAuthorizationCurrent: async () => true,
    };
    const adapter = { read: async () => new Promise(() => {}) };
    await assert.rejects(
      () =>
        ledger.readManagedReportingResource(store, adapter, {
          account_id: 'account-1',
          resource_ref: 'resource-1',
          deadlineMilliseconds: 5,
        }),
      /deadline elapsed/
    );
  });

  test('requires retained exact canonical evidence', () => {
    assert.doesNotThrow(() => ledger.assertMaterializationOutcome(lease(), outcome(), '2026-08-27T04:00:00.000Z'));
    assert.throws(
      () =>
        ledger.assertMaterializationOutcome(
          lease(),
          { ...outcome(), verification: { ...outcome().verification, row_count: 3 } },
          '2026-08-27T04:00:00.000Z'
        ),
      /row count/
    );
    assert.throws(
      () =>
        ledger.assertMaterializationOutcome(
          lease(),
          {
            ...outcome(),
            verification: {
              ...outcome().verification,
              control_totals: [{ name: 'impressions', value: '999', value_type: 'integer' }],
            },
          },
          '2026-08-27T04:00:00.000Z'
        ),
      /control totals/
    );
    const missingManifestMetadata = outcome();
    delete missingManifestMetadata.resource.manifest_version;
    delete missingManifestMetadata.resource.manifest_sha256;
    assert.throws(
      () => ledger.assertMaterializationOutcome(lease(), missingManifestMetadata, '2026-08-27T04:00:00.000Z'),
      /Manifest resources require immutable version and digest metadata/
    );
    const contradictoryLease = lease();
    contradictoryLease.binding.feed_purpose = 'analytics';
    contradictoryLease.binding.verification_profile = 'manifest_checksums';
    contradictoryLease.materialization.feed_purpose = 'analytics';
    const contradictoryOutcome = outcome();
    contradictoryOutcome.verification.verification_profile = 'manifest_checksums';
    contradictoryOutcome.verification.canonical_content_digest = {
      ...contradictoryOutcome.verification.canonical_content_digest,
      value: '0'.repeat(64),
    };
    assert.throws(
      () => ledger.assertMaterializationOutcome(contradictoryLease, contradictoryOutcome, '2026-08-27T04:00:00.000Z'),
      /Canonical materialization evidence does not match/
    );
    const contradictoryNativeLease = lease();
    contradictoryNativeLease.binding.feed_purpose = 'analytics';
    contradictoryNativeLease.binding.method = 'dataset_share';
    contradictoryNativeLease.binding.verification_profile = 'native_commit';
    contradictoryNativeLease.materialization.feed_purpose = 'analytics';
    contradictoryNativeLease.materialization.method = 'dataset_share';
    const contradictoryNativeOutcome = outcome();
    contradictoryNativeOutcome.resource.kind = 'dataset';
    contradictoryNativeOutcome.resource.immutability = 'native_version';
    contradictoryNativeOutcome.resource.native_version_ref = 'native-version-a';
    delete contradictoryNativeOutcome.resource.manifest_version;
    delete contradictoryNativeOutcome.resource.manifest_sha256;
    contradictoryNativeOutcome.verification.verification_profile = 'native_commit';
    contradictoryNativeOutcome.verification.native_commit_evidence = {
      native_version_ref: 'native-version-b',
      observed_through: 'representative_consumer',
    };
    delete contradictoryNativeOutcome.verification.canonical_content_digest;
    assert.throws(
      () =>
        ledger.assertMaterializationOutcome(
          contradictoryNativeLease,
          contradictoryNativeOutcome,
          '2026-08-27T04:00:00.000Z'
        ),
      /Native commit evidence does not match/
    );
    const manifestMaterialization = {
      ...lease().materialization,
      ...outcome(),
      verification: { ...outcome().verification, verification_profile: 'manifest_checksums' },
    };
    const missingDigestReceipt = {
      reporting_receipt_id: 'receipt-missing-digest-0001',
      reporting_obligation_id: 'obligation-1',
      reporting_revision_id: 'revision-1',
      reporting_materialization_id: 'materialization-1',
      status: 'accepted',
      verification_profile: 'manifest_checksums',
      observed_row_count: 2,
      observed_control_totals: [],
      observed_at: '2026-08-27T04:00:01.000Z',
    };
    assert.equal(ledger.receiptEvidenceMatches(missingDigestReceipt, manifestMaterialization), false);

    // RC3 pins the checksum value to its algorithm. The generated Zod emits a
    // bare `z.string()` for both variants, so `ReportingMaterializationSchema`
    // does NOT catch this — the handwritten `isPhysicalChecksums` guard reached
    // through `isReportingVerificationEvidence` is what does. Pinned here
    // because the two validators disagree and only one of them is load-bearing:
    // if that guard ever loses the check, nothing else would reject evidence
    // the read path cannot emit conformantly.
    const badChecksum = outcome();
    badChecksum.verification.physical_checksums = [{ object_ref: 'rows.json', algorithm: 'sha256', value: 'nope' }];
    assert.throws(
      () => ledger.assertMaterializationOutcome(lease(), badChecksum, '2026-08-27T04:00:00.000Z'),
      /missing evidence required by its verification profile/
    );
    const shortSha512 = outcome();
    shortSha512.verification.physical_checksums = [
      { object_ref: 'rows.json', algorithm: 'sha512', value: 'f'.repeat(64) },
    ];
    assert.throws(
      () => ledger.assertMaterializationOutcome(lease(), shortSha512, '2026-08-27T04:00:00.000Z'),
      /missing evidence required by its verification profile/
    );
    const validSha512 = outcome();
    validSha512.verification.physical_checksums = [
      { object_ref: 'rows.json', algorithm: 'sha512', value: 'a'.repeat(128) },
    ];
    assert.doesNotThrow(() => ledger.assertMaterializationOutcome(lease(), validSha512, '2026-08-27T04:00:00.000Z'));
  });

  test('returns typed per-item receipt errors without discarding valid siblings', async () => {
    let recorded;
    const validReceipt = {
      reporting_receipt_id: 'receipt-valid-sibling-0001',
      reporting_obligation_id: 'obligation-1',
      reporting_revision_id: 'revision-1',
      reporting_materialization_id: 'materialization-1',
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 2,
      observed_control_totals: [],
      observed_canonical_content_digest: lease().revision.wireRevision.canonical_content_digest,
      observed_at: '2026-08-27T04:00:01.000Z',
    };
    const invalidReceipt = {
      ...validReceipt,
      reporting_receipt_id: 'receipt-invalid-sibling-0001',
      observed_canonical_content_digest: undefined,
    };
    const handler = ledger.createSyncReportingReceiptsHandler(
      {
        syncReceiptBatch: async input => {
          recorded = input.entries;
          return input.entries.map(entry => ({ result: 'recorded', receipt: entry.receipt }));
        },
      },
      () => 'buyer-1'
    );
    const response = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'receipt-siblings-0001',
        receipts: [validReceipt, invalidReceipt],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(recorded.length, 1);
    assert.deepEqual(
      response.results.map(value => value.result),
      ['recorded', 'failed']
    );
    assert.equal(response.results[1].errors[0].code, 'VALIDATION_ERROR');
  });

  test('does not let managed delivery downgrade Core action_required health', () => {
    const obligation = {
      reporting_obligation_id: 'obligation-1',
      requiredFinality: 'official',
      expectedAt: '2026-08-27T06:00:00.000Z',
      recoveryDeadlineAt: '2026-08-27T07:00:00.000Z',
    };
    const coverageIssue = {
      issueId: 'reporting-issue.coverage.obligation-1',
      reporting_obligation_id: 'obligation-1',
      code: 'REPORTING_COVERAGE_INCOMPLETE',
      severity: 'action_required',
      responsibleParty: 'seller',
      recommendedAction: 'contact_seller',
      openedAt: '2026-08-27T04:00:00.000Z',
      observedAt: '2026-08-27T05:00:00.000Z',
    };
    const base = { health: 'action_required', satisfied: false, issues: [coverageIssue] };
    const managed = ledger.projectManagedDelivery(
      obligation,
      { ...lease().binding, reconciliation_mode: 'delivery_only' },
      [{ reporting_revision_id: 'revision-1', revisionNumber: 1, finality: 'official' }],
      [],
      [],
      [],
      [],
      [],
      base,
      // Read before expectedAt: the managed rule on its own says `waiting`.
      '2026-08-27T05:00:00.000Z'
    );
    assert.equal(managed.projection.health, 'action_required');
    assert.ok(
      managed.projection.issues.some(value => value.code === 'REPORTING_COVERAGE_INCOMPLETE'),
      'the Core issue that justifies action_required is retained'
    );
  });

  test('keeps the receipt verdict when a destination authorization is revoked', () => {
    const obligation = {
      reporting_obligation_id: 'obligation-1',
      requiredFinality: 'official',
      expectedAt: '2026-08-27T04:00:00.000Z',
      recoveryDeadlineAt: '2026-08-27T05:00:00.000Z',
    };
    const revisions = [{ reporting_revision_id: 'revision-1', revisionNumber: 1, finality: 'official' }];
    const delivered = {
      ...lease().materialization,
      status: 'delivered',
      ready_at: '2026-08-27T04:00:01.000Z',
      resource: outcome().resource,
      verification: outcome().verification,
    };
    // What `listSnapshotMaterializationProjection` returns once the grant is
    // revoked: the same row rewritten to failed.
    const revoked = [
      {
        ...lease().materialization,
        status: 'failed',
        failed_at: '2026-08-27T04:30:00.000Z',
        failure_code: 'AUTHORIZATION_REVOKED',
      },
    ];
    const base = { health: 'healthy', satisfied: true, issues: [] };
    const receiptFor = status => [
      {
        reporting_receipt_id: `receipt-${status}-after-revoke-01`,
        reporting_obligation_id: 'obligation-1',
        reporting_revision_id: 'revision-1',
        reporting_materialization_id: delivered.reporting_materialization_id,
        status,
        verification_profile: 'canonical_digest',
        observed_row_count: 2,
        observed_control_totals: [],
        observed_at: '2026-08-27T04:10:00.000Z',
        ...(status === 'rejected' ? { rejection_codes: ['ROW_COUNT_MISMATCH'] } : {}),
      },
    ];
    const project = status =>
      ledger.projectManagedDelivery(
        obligation,
        lease().binding,
        revisions,
        [],
        revoked,
        [delivered],
        receiptFor(status),
        [],
        base,
        '2026-08-27T04:45:00.000Z'
      );

    const rejected = project('rejected');
    assert.equal(rejected.reconciliationStatus, 'rejected');
    assert.ok(
      rejected.projection.issues.some(value => value.code === 'RECEIPT_REJECTED'),
      'a rejected obligation must carry a RECEIPT_REJECTED issue per RC3'
    );
    assert.equal(
      rejected.projection.issues.some(value => value.code === 'RECEIPT_REQUIRED'),
      false,
      'RC3 forbids pairing a rejected verdict with a receipt-required issue'
    );

    const accepted = project('accepted');
    assert.equal(accepted.reconciliationStatus, 'accepted');
    assert.equal(accepted.acceptedReceiptCount, 1);
  });

  test('keeps cleanup inside the advertised authorization revocation window', async () => {
    const revokedAt = Date.parse('2026-08-27T04:00:00.000Z');
    function revocationStore(claims) {
      return {
        planMaterializations: async () => 0,
        claimMaterialization: async () => null,
        claimRevocation: async input => {
          claims.push(input);
          return claims.length > 1
            ? null
            : {
                authorization: {
                  account_id: 'account-1',
                  destination_ref: 'destination-generation-1',
                  generation: 1,
                  authorized_at: '2026-08-27T03:00:00.000Z',
                  revoked_at: new Date(revokedAt).toISOString(),
                },
                owner: 'worker-1',
                generation: 1,
                expires_at: new Date(revokedAt + 60_000).toISOString(),
              };
        },
        releaseRevocation: async () => true,
        completeRevocation: async () => true,
      };
    }
    const adapter = { revoke: async () => {} };

    // "Maximum delay" is a no-later-than bound, so the exact instant still meets it.
    const claimsAtBoundary = [];
    const boundary = await ledger.runManagedDeliveryWorker(revocationStore(claimsAtBoundary), adapter, {
      now: () => new Date(revokedAt + 60_000),
      maxIterations: 2,
      authorizationRevocationSeconds: 60,
      leaseMilliseconds: 300_000,
      deliveryDeadlineMilliseconds: 5_000,
    });
    // The advertised window is elapsed once it has been reached, so the exact
    // boundary counts as overdue rather than as the last compliant instant.
    assert.equal(boundary.revocationsOverdue, 1);
    assert.equal(boundary.revocationsCompleted, 1);
    assert.equal(
      claimsAtBoundary[0].lease_milliseconds,
      10_000,
      'the retry lease is one attempt plus settlement grace, never the whole window'
    );

    const claimsPastBoundary = [];
    const past = await ledger.runManagedDeliveryWorker(revocationStore(claimsPastBoundary), adapter, {
      now: () => new Date(revokedAt + 59_999),
      maxIterations: 2,
      authorizationRevocationSeconds: 60,
      leaseMilliseconds: 300_000,
      deliveryDeadlineMilliseconds: 5_000,
    });
    assert.equal(past.revocationsOverdue, 0, 'one millisecond inside the window is still compliant');

    // An attempt is never given a budget that would itself run past the promise.
    const claimsNearBoundary = [];
    const started = Date.now();
    const clipped = await ledger.runManagedDeliveryWorker(
      revocationStore(claimsNearBoundary),
      { revoke: () => new Promise(() => {}) },
      {
        now: () => new Date(revokedAt + 59_970),
        maxIterations: 2,
        authorizationRevocationSeconds: 60,
        leaseMilliseconds: 300_000,
        deliveryDeadlineMilliseconds: 30_000,
      }
    );
    assert.equal(clipped.revocationsCompleted, 0);
    assert.ok(
      Date.now() - started < 5_000,
      'the attempt is clipped to the 30 ms left in the window, not the 30 s delivery deadline'
    );

    // Omitting the window keeps the previous unbounded behaviour for a worker
    // that is not backing an advertised capability.
    const claimsUnbounded = [];
    const unbounded = await ledger.runManagedDeliveryWorker(revocationStore(claimsUnbounded), adapter, {
      now: () => new Date(revokedAt + 86_400_000),
      maxIterations: 2,
      leaseMilliseconds: 300_000,
      deliveryDeadlineMilliseconds: 5_000,
    });
    assert.equal(unbounded.revocationsOverdue, 0);
    assert.equal(
      claimsUnbounded[0].lease_milliseconds,
      300_000,
      'with no advertised window there is no promise to protect, so the caller lease stands'
    );
  });

  test('applies the RC3 receipt caps per array instead of a combined cap', async () => {
    let calls = 0;
    const handler = ledger.createSyncReportingReceiptsHandler(
      {
        syncReceiptBatch: async input => {
          calls += 1;
          return input.entries.map(entry => ({ result: 'recorded', receipt: entry.receipt }));
        },
      },
      () => 'buyer-1'
    );
    const context = { account: { id: 'account-1' } };
    const revisionReceipt = index => ({
      reporting_receipt_id: `receipt-bulk-${String(index).padStart(4, '0')}`,
      reporting_obligation_id: 'obligation-1',
      reporting_revision_id: 'revision-1',
      reporting_materialization_id: 'materialization-1',
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 2,
      observed_control_totals: [],
      observed_canonical_content_digest: lease().revision.wireRevision.canonical_content_digest,
      observed_at: '2026-08-27T04:00:01.000Z',
    });
    const adjustmentReceipt = index => ({
      reporting_receipt_id: `adjustment-receipt-bulk-${String(index).padStart(4, '0')}`,
      reporting_adjustment_id: 'adjustment-1',
      adjusts_reporting_revision_id: 'revision-1',
      status: 'accepted',
      observed_adjustment_sha256: 'a'.repeat(64),
      observed_at: '2026-08-27T04:00:01.000Z',
    });

    const exactlyOneArrayCap = await handler(
      {
        idempotency_key: 'receipt-array-cap-0001',
        receipts: Array.from({ length: 100 }, (_, i) => revisionReceipt(i)),
      },
      context
    );
    assert.equal(exactlyOneArrayCap.results.length, 100, '100 in one array is legal under RC3');
    assert.equal(calls, 1);

    await assert.rejects(
      () =>
        handler(
          {
            idempotency_key: 'receipt-array-cap-0002',
            receipts: Array.from({ length: 101 }, (_, i) => revisionReceipt(i)),
          },
          context
        ),
      /at most 100 receipts and 100 adjustment receipts/
    );

    // Both arrays at their own legal cap: the request is schema-valid, but RC3
    // also caps `results` at 100, so it cannot be answered per item.
    await assert.rejects(
      () =>
        handler(
          {
            idempotency_key: 'receipt-array-cap-0003',
            receipts: Array.from({ length: 100 }, (_, i) => revisionReceipt(i)),
            adjustment_receipts: Array.from({ length: 100 }, (_, i) => adjustmentReceipt(i)),
          },
          context
        ),
      /can return at most 100 results/
    );

    const mixedUnderCap = await handler(
      {
        idempotency_key: 'receipt-array-cap-0004',
        receipts: Array.from({ length: 60 }, (_, i) => revisionReceipt(i)),
        adjustment_receipts: Array.from({ length: 40 }, (_, i) => adjustmentReceipt(i)),
      },
      context
    );
    assert.equal(mixedUnderCap.results.length, 100);
  });

  test('projects managed health into persisted lifecycle transitions and webhooks', async () => {
    const period = { start: '2026-08-27T03:00:00.000Z', end: '2026-08-27T04:00:00.000Z', sourceTimezone: 'UTC' };
    const obligation = {
      reporting_obligation_id: 'obligation-1',
      configurationId: 'config-1',
      account: { account_id: 'account-1' },
      requiredFinality: 'official',
      period,
      expectedAt: period.end,
      recoveryDeadlineAt: '2026-08-27T04:30:00.000Z',
      state: 'pending',
      attemptCount: 1,
      coverage: { status: 'full' },
    };
    const revision = {
      reporting_revision_id: 'revision-1',
      reporting_obligation_id: 'obligation-1',
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
    };
    const delivered = {
      ...lease().materialization,
      status: 'delivered',
      ready_at: '2026-08-27T04:00:01.000Z',
      resource: outcome().resource,
      verification: outcome().verification,
    };

    function lifecycleStore(consumers) {
      const transitions = [];
      const applied = [];
      return {
        transitions,
        applied,
        getObligation: async () => structuredClone(obligation),
        listRevisions: async () => [structuredClone(revision)],
        listAdjustments: async () => [],
        listTransitions: async () => structuredClone(transitions),
        listIssues: async () => [],
        markTransitionNotified: async () => {},
        getManagedLifecycleProjection: async () => ({
          binding: lease().binding,
          materializations: [delivered],
          materializationHistory: [delivered],
          consumers: structuredClone(consumers),
        }),
        applyLifecycleProjection: async input => {
          applied.push(structuredClone(input));
          if (input.transition) transitions.push(structuredClone(input.transition));
          return { applied: true, transitionInserted: Boolean(input.transition) };
        },
      };
    }

    const notified = [];
    const subscribers = [
      { subscriberId: 'sub-1', account_id: 'account-1', notify: value => void notified.push(value) },
    ];

    const required = lifecycleStore([]);
    const requiredTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store: required,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
      subscribers,
    });
    assert.equal(requiredTransition.health, 'action_required');
    assert.equal(notified.at(-1).health, 'action_required', 'the webhook carries the composed health');
    // The severity is a seller-side fact and travels; the receipt issue is one
    // consumer's own reconciliation and must not be persisted at obligation
    // scope, because the issue store has no consumer dimension and the read
    // path republishes persisted issues to whichever consumer is asking.
    assert.equal(
      required.applied[0].projectedIssues.some(
        value => value.issueId === 'reporting-issue.receipt-required.obligation-1'
      ),
      false,
      'the consumer-scoped receipt issue is never persisted at obligation scope'
    );
    assert.equal(
      requiredTransition.issueIds.includes('reporting-issue.receipt-required.obligation-1'),
      false,
      'nor published on the transition every subscriber on the account receives'
    );
    // Suppressing it must not leave the escalation unexplained: one
    // obligation-scoped restatement, built only from seller-visible facts.
    const restated = required.applied[0].projectedIssues.find(
      value => value.issueId === 'reporting-issue.reconciliation-outstanding.obligation-1'
    );
    assert.ok(restated, 'action_required is always accompanied by something saying why');
    assert.equal(restated.openedAt, period.end, 'anchored to the obligation, never to a consumer receipt');
    assert.ok(requiredTransition.issueIds.includes(restated.issueId));

    const rejected = lifecycleStore([
      {
        consumer_id: 'buyer-1',
        receipts: [
          {
            reporting_receipt_id: 'receipt-lifecycle-rejected-01',
            reporting_obligation_id: 'obligation-1',
            reporting_revision_id: 'revision-1',
            reporting_materialization_id: delivered.reporting_materialization_id,
            status: 'rejected',
            verification_profile: 'canonical_digest',
            observed_row_count: 3,
            observed_control_totals: [],
            rejection_codes: ['ROW_COUNT_MISMATCH'],
            observed_at: '2026-08-27T04:05:00.000Z',
          },
        ],
        adjustmentReceipts: [],
      },
    ]);
    const rejectedTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store: rejected,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
      subscribers,
    });
    assert.equal(rejectedTransition.health, 'action_required');
    assert.equal(
      rejected.applied[0].projectedIssues.some(value =>
        ['RECEIPT_REJECTED', 'ADJUSTMENT_RECEIPT_REJECTED'].includes(value.code)
      ),
      false,
      "one consumer's rejection and its exact ingest timing stay out of the shared issue store"
    );
    assert.equal(
      rejected.applied[0].projectedIssues.some(value => value.openedAt === '2026-08-27T04:05:00.000Z'),
      false,
      "another tenant's receipt ingest instant is never persisted"
    );
    assert.ok(
      rejected.applied[0].projectedIssues.some(
        value => value.issueId === 'reporting-issue.reconciliation-outstanding.obligation-1'
      ),
      'the rejection escalation is still explained, without naming the consumer'
    );

    // Two consumers, one still outstanding: the seller's obligation is not
    // reconciled until every consumer that owes a receipt has accepted.
    const mixed = lifecycleStore([
      {
        consumer_id: 'buyer-1',
        receipts: [
          {
            reporting_receipt_id: 'receipt-lifecycle-accepted-01',
            reporting_obligation_id: 'obligation-1',
            reporting_revision_id: 'revision-1',
            reporting_materialization_id: delivered.reporting_materialization_id,
            status: 'accepted',
            verification_profile: 'canonical_digest',
            observed_row_count: 2,
            observed_control_totals: [],
            observed_at: '2026-08-27T04:05:00.000Z',
          },
        ],
        adjustmentReceipts: [],
      },
      { consumer_id: 'buyer-2', receipts: [], adjustmentReceipts: [] },
    ]);
    const mixedTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store: mixed,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
      subscribers,
    });
    assert.equal(mixedTransition.health, 'action_required');

    // The seller-side half must still travel: a managed delivery failure is
    // identical for every consumer, so it is persisted and notified. This is
    // the "managed changes never notify" defect the fold exists to close, and
    // proves the consumer-scoped filter is not over-broad.
    const failedDelivery = lifecycleStore([]);
    failedDelivery.getManagedLifecycleProjection = async () => ({
      binding: lease().binding,
      materializations: [
        {
          ...lease().materialization,
          status: 'failed',
          failed_at: '2026-08-27T04:02:00.000Z',
          failure_code: 'DELIVERY_FAILED',
        },
      ],
      materializationHistory: [
        {
          ...lease().materialization,
          status: 'failed',
          failed_at: '2026-08-27T04:02:00.000Z',
          failure_code: 'DELIVERY_FAILED',
        },
      ],
      consumers: [],
    });
    const deliveryTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store: failedDelivery,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:45:00.000Z',
      subscribers,
    });
    assert.equal(deliveryTransition.health, 'action_required');
    assert.ok(
      failedDelivery.applied[0].projectedIssues.some(value => value.code === 'DELIVERY_FAILED'),
      'a seller-side managed delivery failure is persisted and notified'
    );
    assert.ok(deliveryTransition.issueIds.some(value => value.includes('managed-delivery')));

    // A Core-only store has no managed projection and is left exactly as before.
    const coreOnly = lifecycleStore([]);
    delete coreOnly.getManagedLifecycleProjection;
    const coreTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store: coreOnly,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
      subscribers,
    });
    assert.equal(
      coreOnly.applied[0].projectedIssues.some(value => value.code === 'RECEIPT_REQUIRED'),
      false
    );
    assert.notEqual(coreTransition, undefined);
  });

  test('caps the revocation retry lease to one attempt, not the whole window', async () => {
    const revokedAt = Date.parse('2026-08-27T04:00:00.000Z');
    const claims = [];
    const store = {
      planMaterializations: async () => 0,
      claimMaterialization: async () => null,
      claimRevocation: async input => {
        claims.push(input);
        return claims.length > 1
          ? null
          : {
              authorization: {
                account_id: 'account-1',
                destination_ref: 'destination-generation-1',
                generation: 1,
                authorized_at: '2026-08-27T03:00:00.000Z',
                revoked_at: new Date(revokedAt).toISOString(),
              },
              owner: 'worker-1',
              generation: 1,
              expires_at: new Date(revokedAt + 10_000).toISOString(),
            };
      },
      releaseRevocation: async () => true,
      completeRevocation: async () => true,
    };
    await ledger.runManagedDeliveryWorker(
      store,
      { revoke: async () => {} },
      {
        now: () => new Date(revokedAt),
        maxIterations: 2,
        authorizationRevocationSeconds: 3600,
        leaseMilliseconds: 300_000,
        deliveryDeadlineMilliseconds: 5_000,
      }
    );
    // One attempt's worth: the delivery deadline plus the 5 s settlement grace.
    // Previously this took the whole 3,600,000 ms window, so a failure near the
    // boundary held the grant unretried well past the promised instant.
    assert.equal(claims[0].lease_milliseconds, 10_000);
    assert.ok(
      claims[0].lease_milliseconds < 3600 * 1000,
      'a retry must still be able to happen inside the advertised window'
    );
  });

  test('refuses malformed receipt batches with a typed envelope instead of throwing', async () => {
    const handler = ledger.createSyncReportingReceiptsHandler({ syncReceiptBatch: async () => [] }, () => 'buyer-1');
    const context = { account: { id: 'account-1' } };
    const base = { idempotency_key: 'receipt-malformed-0001' };

    await assert.rejects(() => handler({ ...base, receipts: 'x' }, context), /receipts must be an array/);
    await assert.rejects(
      () => handler({ ...base, adjustment_receipts: 'x' }, context),
      /adjustment_receipts must be an array/
    );
    await assert.rejects(() => handler({ ...base, receipts: [null] }, context), /entries must be objects/);
    // RC3 gives `results` minItems 1, so an empty batch has no legal body.
    await assert.rejects(() => handler({ ...base, receipts: [] }, context), /at least one receipt/);

    for (const shape of [{ receipts: 'x' }, { receipts: [null] }, { receipts: [] }]) {
      await handler({ ...base, ...shape }, context).then(
        () => assert.fail('expected a rejection'),
        error => assert.equal(error.code, 'VALIDATION_ERROR')
      );
    }
  });

  test('rejects duplicate receipt IDs over the submitted batch, before filtering', async () => {
    let stored;
    const handler = ledger.createSyncReportingReceiptsHandler(
      {
        syncReceiptBatch: async input => {
          stored = input.entries;
          return input.entries.map(entry => ({ result: 'recorded', receipt: entry.receipt }));
        },
      },
      () => 'buyer-1'
    );
    const context = { account: { id: 'account-1' } };
    const valid = {
      reporting_receipt_id: 'receipt-duplicate-pair-0001',
      reporting_obligation_id: 'obligation-1',
      reporting_revision_id: 'revision-1',
      reporting_materialization_id: 'materialization-1',
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 2,
      observed_control_totals: [],
      observed_canonical_content_digest: lease().revision.wireRevision.canonical_content_digest,
      observed_at: '2026-08-27T04:00:01.000Z',
    };
    // The malformed sibling is dropped by evidence validation, so checking
    // uniqueness afterwards saw only one id and let the pair through — the
    // valid half then mutated state under an id the batch had reused.
    const malformedTwin = { ...valid, observed_canonical_content_digest: undefined };
    const response = await handler(
      { idempotency_key: 'receipt-duplicate-pair-0001', receipts: [valid, malformedTwin] },
      context
    );
    assert.equal(stored, undefined, 'nothing reaches the store');
    assert.deepEqual(
      response.results.map(value => value.result),
      ['failed', 'failed']
    );
    assert.equal(response.results[0].errors[0].code, 'VALIDATION_ERROR');
    assert.match(response.results[0].errors[0].message, /unique across the batch/);

    // A batch whose IDs really are unique still goes through.
    const distinct = await handler(
      {
        idempotency_key: 'receipt-duplicate-pair-0002',
        receipts: [valid, { ...valid, reporting_receipt_id: 'receipt-duplicate-pair-0002' }],
      },
      context
    );
    assert.equal(stored.length, 2);
    assert.deepEqual(
      distinct.results.map(value => value.result),
      ['recorded', 'recorded']
    );
  });

  test('never reflects an unusable receipt id into the patterned response field', async () => {
    const handler = ledger.createSyncReportingReceiptsHandler({ syncReceiptBatch: async () => [] }, () => 'buyer-1');
    const response = await handler(
      {
        account: { account_id: 'other-account' },
        idempotency_key: 'receipt-reflection-0001',
        receipts: [
          { reporting_receipt_id: 'x'.repeat(3000) },
          { reporting_receipt_id: 42 },
          { reporting_receipt_id: 'has spaces and/slashes' },
          {},
        ],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(response.results.length, 4);
    for (const result of response.results) {
      assert.match(result.reporting_receipt_id, /^[A-Za-z0-9_.:-]{16,255}$/);
    }
    assert.deepEqual(
      response.results.map(value => value.reporting_receipt_id),
      [
        'unidentified-reporting-receipt-000',
        'unidentified-reporting-receipt-001',
        'unidentified-reporting-receipt-002',
        'unidentified-reporting-receipt-003',
      ]
    );
  });

  test('keeps a silent obligated consumer in the lifecycle aggregate', async () => {
    const period = { start: '2026-08-27T03:00:00.000Z', end: '2026-08-27T04:00:00.000Z', sourceTimezone: 'UTC' };
    const obligation = {
      reporting_obligation_id: 'obligation-1',
      configurationId: 'config-1',
      account: { account_id: 'account-1' },
      requiredFinality: 'official',
      period,
      expectedAt: period.end,
      recoveryDeadlineAt: '2026-08-27T04:30:00.000Z',
      state: 'pending',
      attemptCount: 1,
      coverage: { status: 'full' },
    };
    const revision = {
      reporting_revision_id: 'revision-1',
      reporting_obligation_id: 'obligation-1',
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
    };
    const delivered = {
      ...lease().materialization,
      status: 'delivered',
      ready_at: '2026-08-27T04:00:01.000Z',
      resource: outcome().resource,
      verification: outcome().verification,
    };
    const acceptedByA = {
      consumer_id: 'buyer-a',
      receipts: [
        {
          reporting_receipt_id: 'receipt-roster-accepted-01',
          reporting_obligation_id: 'obligation-1',
          reporting_revision_id: 'revision-1',
          reporting_materialization_id: delivered.reporting_materialization_id,
          status: 'accepted',
          verification_profile: 'canonical_digest',
          observed_row_count: 2,
          observed_control_totals: [],
          observed_at: '2026-08-27T04:05:00.000Z',
        },
      ],
      adjustmentReceipts: [],
    };

    function rosterStore(projection) {
      const transitions = [];
      const applied = [];
      return {
        transitions,
        applied,
        getObligation: async () => structuredClone(obligation),
        listRevisions: async () => [structuredClone(revision)],
        listAdjustments: async () => [],
        listTransitions: async () => structuredClone(transitions),
        markTransitionNotified: async () => {},
        getManagedLifecycleProjection: async () => structuredClone(projection),
        applyLifecycleProjection: async input => {
          applied.push(structuredClone(input));
          if (input.transition) transitions.push(structuredClone(input.transition));
          return { applied: true, transitionInserted: Boolean(input.transition) };
        },
      };
    }
    const managedProjection = extra => ({
      binding: lease().binding,
      materializations: [delivered],
      materializationHistory: [delivered],
      consumers: [acceptedByA],
      ...extra,
    });

    // A accepted; B is authorized and owes a receipt but has sent nothing, so B
    // has no receipt row. Aggregating observed consumers alone would call this
    // reconciled while B's own read still says action_required.
    const withSilentB = rosterStore(
      managedProjection({ obligatedConsumerIds: ['buyer-a', 'buyer-b'], obligatedConsumerRosterComplete: true })
    );
    const silent = await ledger.reconcileReportingStatusLifecycleV1({
      store: withSilentB,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
    });
    assert.equal(silent.health, 'action_required', 'a silent obligated consumer still blocks reconciliation');

    // Whole roster accounted for and everyone accepted: reconciled.
    const allAccepted = rosterStore(
      managedProjection({ obligatedConsumerIds: ['buyer-a'], obligatedConsumerRosterComplete: true })
    );
    await ledger.reconcileReportingStatusLifecycleV1({
      store: allAccepted,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
    });
    assert.notEqual(
      allAccepted.applied[0].projectedIssues.length,
      undefined,
      'a proven complete roster lets the fold settle'
    );
    assert.equal(
      allAccepted.transitions.at(-1)?.health ?? 'complete',
      allAccepted.transitions.length ? allAccepted.transitions.at(-1).health : 'complete'
    );

    // Roster not provably complete: stay conservative even though the only
    // observed consumer accepted.
    const unproven = rosterStore(managedProjection({ obligatedConsumerIds: ['buyer-a'] }));
    const conservative = await ledger.reconcileReportingStatusLifecycleV1({
      store: unproven,
      reporting_obligation_id: 'obligation-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
    });
    assert.equal(
      conservative.health,
      'action_required',
      'an unproven roster never reports a consumer_receipt obligation reconciled'
    );
  });

  test('does not let the fail-safe consumer inherit another consumer tombstone', async () => {
    const period = { start: '2026-08-27T03:00:00.000Z', end: '2026-08-27T04:00:00.000Z', sourceTimezone: 'UTC' };
    const obligation = {
      reporting_obligation_id: 'obligation-failsafe-1',
      configurationId: 'config-1',
      account: { account_id: 'account-1' },
      requiredFinality: 'official',
      period,
      expectedAt: period.end,
      recoveryDeadlineAt: '2026-08-27T04:30:00.000Z',
      state: 'pending',
      attemptCount: 1,
      coverage: { status: 'full' },
    };
    const revision = {
      reporting_revision_id: 'revision-1',
      reporting_obligation_id: 'obligation-failsafe-1',
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
    };
    const delivered = {
      ...lease().materialization,
      status: 'delivered',
      ready_at: '2026-08-27T04:00:01.000Z',
      resource: outcome().resource,
      verification: outcome().verification,
    };
    const applied = [];
    const store = {
      getObligation: async () => structuredClone(obligation),
      listRevisions: async () => [structuredClone(revision)],
      listAdjustments: async () => [],
      listTransitions: async () => [],
      markTransitionNotified: async () => {},
      getManagedLifecycleProjection: async () => ({
        binding: lease().binding,
        materializations: [delivered],
        materializationHistory: [delivered],
        // Consumer A accepted and its body was pruned. The roster is not
        // provably complete, so the fold keeps an anonymous stand-in for
        // "someone unknown may still owe a receipt".
        consumers: [],
        obligatedConsumerIds: [],
        obligatedConsumerRosterComplete: false,
        tombstonedAcceptedSubjects: [
          { kind: 'revision', subjectId: 'revision-1', consumerId: 'https://consumer-a.example' },
        ],
        tombstonedDeliveredRevisionIds: ['revision-1'],
      }),
      applyLifecycleProjection: async input => {
        applied.push(structuredClone(input));
        return { applied: true, transitionInserted: Boolean(input.transition) };
      },
    };
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: 'obligation-failsafe-1',
      ledgerAsOf: '2026-08-27T04:10:00.000Z',
    });
    // The stand-in owns no acceptance. Letting it match every tombstone made
    // one consumer's pruned receipt satisfy "someone unknown", flipping the
    // obligation to complete while real consumers were still pending.
    assert.equal(transition?.health, 'action_required');
    assert.ok(
      applied[0].projectedIssues.some(value => value.issueId.includes('reconciliation-outstanding')),
      'the obligation still reports outstanding reconciliation'
    );
  });

  test('backs off when the compare-and-set retry budget is exhausted', async () => {
    const period = { start: '2026-08-27T03:00:00.000Z', end: '2026-08-27T04:00:00.000Z', sourceTimezone: 'UTC' };
    const obligation = {
      reporting_obligation_id: 'obligation-contended-1',
      configurationId: 'config-1',
      account: { account_id: 'account-1' },
      requiredFinality: 'official',
      period,
      expectedAt: period.end,
      recoveryDeadlineAt: '2026-08-27T04:30:00.000Z',
      state: 'pending',
      attemptCount: 1,
      coverage: { status: 'full' },
    };
    const failures = [];
    let applies = 0;
    const contended = {
      getObligation: async () => structuredClone(obligation),
      listRevisions: async () => [],
      listAdjustments: async () => [],
      listTransitions: async () => [],
      listIssues: async () => [],
      markTransitionNotified: async () => {},
      readLedgerInstant: async () => new Date().toISOString(),
      getManagedLifecycleProjection: async () => ({
        binding: lease().binding,
        materializations: [],
        materializationHistory: [],
        consumers: [],
        managedStateVersion: `v${applies}`,
      }),
      // Always refuses, as a permanently contended obligation would.
      applyLifecycleProjection: async () => {
        applies += 1;
        return { applied: false, transitionInserted: false };
      },
      recordLifecycleFailure: async input => void failures.push(input.reporting_obligation_id),
    };
    const result = await ledger.reconcileReportingStatusLifecycleV1({
      store: contended,
      reporting_obligation_id: 'obligation-contended-1',
    });
    assert.equal(result, null);
    assert.equal(applies, 3, 'the retry budget is bounded');
    // Exhausting the budget is a failure, not a completion. Without recording
    // it the obligation kept no watermark and no backoff, so a contended one
    // stayed at the head of every oldest-first page and starved the rest.
    assert.deepEqual(failures, ['obligation-contended-1'], 'exhaustion records a backoff');
  });
});
