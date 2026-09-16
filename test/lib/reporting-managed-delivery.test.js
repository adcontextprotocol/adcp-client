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
});
