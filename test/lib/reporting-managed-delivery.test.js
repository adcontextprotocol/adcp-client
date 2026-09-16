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
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...common,
          automatedRecoveryWindowSeconds: 1,
        }),
      /must equal every installed managed Core recovery window/
    );
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
      claimRevocation: async () => leases.shift() ?? null,
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
    assert.equal(boundary.revocationsOverdue, 0);
    assert.equal(boundary.revocationsCompleted, 1);
    assert.equal(
      claimsAtBoundary[0].lease_milliseconds,
      60_000,
      'a retry lease may never outlast the whole advertised window'
    );

    const claimsPastBoundary = [];
    const past = await ledger.runManagedDeliveryWorker(revocationStore(claimsPastBoundary), adapter, {
      now: () => new Date(revokedAt + 60_001),
      maxIterations: 2,
      authorizationRevocationSeconds: 60,
      leaseMilliseconds: 300_000,
      deliveryDeadlineMilliseconds: 5_000,
    });
    assert.equal(past.revocationsOverdue, 1);

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
    assert.equal(claimsUnbounded[0].lease_milliseconds, 300_000);
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
    assert.ok(
      required.applied[0].projectedIssues.some(value => value.code === 'RECEIPT_REQUIRED'),
      'the managed issue is persisted, not only projected at read time'
    );
    assert.equal(notified.at(-1).health, 'action_required', 'the webhook carries the composed health');

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
    assert.ok(rejected.applied[0].projectedIssues.some(value => value.code === 'RECEIPT_REJECTED'));

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
});
