const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateReportingLedger, loadReportingLedger, reconcileReporting } = require('../dist/lib/index.js');

const period = {
  start: '2026-08-01T00:00:00Z',
  end: '2026-09-01T00:00:00Z',
  source_timezone: 'UTC',
};
const totals = [
  { name: 'impressions', value: '4200', value_type: 'integer', unit: 'impressions' },
  { name: 'spend', value: '7000.00', value_type: 'decimal', unit: 'USD' },
];
const digest = {
  algorithm: 'sha256',
  value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  canonicalization_id: 'rows-v1',
  canonicalization_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const revision = {
  reporting_revision_id: 'revision-august-official',
  report_definition_id: 'billing-v1',
  reporting_profile: 'billing-v1',
  schema_version: '1',
  schema_uri: 'https://schemas.example/billing-v1.json',
  schema_sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  account_id: 'account-1',
  media_buy_ids: ['buy-1', 'buy-2'],
  period,
  finality: 'official',
  observed_at: '2026-09-02T00:00:00Z',
  data_through: '2026-09-01T00:00:00Z',
  data_through_precision: 'exact',
  row_count: 7,
  control_totals: totals,
  canonical_content_digest: digest,
  created_at: '2026-09-02T00:00:00Z',
};

function obligation(id = 'obligation-billing') {
  return {
    reporting_obligation_id: id,
    delivery_config_id: 'billing-feed',
    delivery_config_version: 1,
    report_definition_id: 'billing-v1',
    feed_purpose: 'billing',
    reporting_profile: 'billing-v1',
    account_id: 'account-1',
    media_buy_ids: ['buy-1', 'buy-2'],
    period,
    expected_at: '2026-09-02T00:00:00Z',
    schedule: { period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' },
    destination_ref: `destination-${id}`,
    required_finality: 'official',
    reconciliation_mode: 'consumer_receipt',
    reconciliation_status: 'pending',
    health: 'waiting',
    production_status: 'published',
    revision_count: 1,
    materialization_count: 1,
    successful_materialization_count: 1,
    receipt_count: 0,
    accepted_receipt_count: 0,
    issues: [],
    resource_retained_until: '2026-12-01T00:00:00Z',
  };
}

function materialization(id = 'materialization-billing', obligationId = 'obligation-billing') {
  return {
    reporting_materialization_id: id,
    reporting_revision_id: revision.reporting_revision_id,
    reporting_obligation_id: obligationId,
    delivery_config_id: 'billing-feed',
    delivery_config_version: 1,
    destination_ref: `destination-${obligationId}`,
    feed_purpose: 'billing',
    method: 'dataset_share',
    transport: 'delta_sharing',
    attempt: 1,
    status: 'available',
    ready_at: '2026-09-02T00:00:05Z',
    resource: {
      resource_ref: `resource-${id}`,
      kind: 'dataset',
      location: 'share.billing',
      native_version_ref: 'version-42',
      immutability: 'native_version',
      expires_at: '2026-12-01T00:00:00Z',
    },
    verification: {
      verified_at: '2026-09-02T00:00:05Z',
      verification_path: 'representative_consumer',
      verification_profile: 'canonical_digest',
      row_count: 7,
      control_totals: totals,
      canonical_content_digest: digest,
    },
    created_at: '2026-09-02T00:00:01Z',
  };
}

function response(receipts = []) {
  const item = obligation();
  if (receipts.length) {
    item.reconciliation_status = 'accepted';
    item.health = 'complete';
    item.receipt_count = 1;
    item.accepted_receipt_count = 1;
  }
  return {
    status: 'completed',
    view: 'periods',
    ledger_snapshot_id: receipts.length ? 'snapshot-after-receipt' : 'snapshot-before-receipt',
    ledger_as_of: receipts.length ? '2026-09-02T00:01:01Z' : '2026-09-02T00:00:06Z',
    account_id: 'account-1',
    scope: {
      period_start: period.start,
      period_end: period.end,
      scope_closed: true,
      media_buy_ids: ['buy-1', 'buy-2'],
      all_accessible_media_buys: false,
      delivery_config_generations: [
        { delivery_config_id: 'billing-feed', delivery_config_version: 1, feed_purpose: 'billing' },
      ],
      feed_purposes: ['billing'],
      finality: ['official'],
      ledger_retained_from: '2026-07-01T00:00:00Z',
      coverage_complete: true,
    },
    periods: [item],
    revisions: [revision],
    materializations: [materialization()],
    receipts,
    pagination: { has_more: false, total_count: 3 + receipts.length },
  };
}

test('reconciles a closed billing period, retries inspection, and records a matching receipt', async () => {
  let recordedReceipt;
  let inspections = 0;
  const client = {
    async getReportingStatus() {
      return response(recordedReceipt ? [recordedReceipt] : []);
    },
    async syncReportingReceipts(request) {
      recordedReceipt = { ...request.receipts[0], received_at: '2026-09-02T00:01:00Z' };
      return { status: 'completed', results: [{ result: 'recorded', receipt: recordedReceipt }] };
    },
  };

  const result = await reconcileReporting({
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [
      {
        deliveryConfigId: 'billing-feed',
        deliveryConfigVersion: 1,
        periodStart: period.start,
        periodEnd: period.end,
      },
    ],
    now: new Date('2026-09-03T00:00:00Z'),
    async inspect() {
      inspections += 1;
      if (inspections === 1) throw new Error('transient warehouse read');
      return {
        rowCount: 7,
        controlTotals: totals,
        canonicalContentDigest: digest,
        consumerCommitRef: 'buyer-ledger-42',
      };
    },
  });

  assert.equal(result.definitive, true);
  assert.equal(inspections, 2);
  assert.equal(result.submittedReceipts.length, 1);
  assert.equal(result.submittedReceipts[0].status, 'accepted');
  assert.deepEqual(result.totalsByRevision, [
    {
      reportingRevisionId: revision.reporting_revision_id,
      rowCount: 7,
      controlTotals: totals,
    },
  ]);
});

test('does not claim completeness when an expected seller obligation is missing', async () => {
  const ledger = await loadReportingLedger(
    {
      async getReportingStatus() {
        return response([]);
      },
      async syncReportingReceipts() {
        throw new Error('not called');
      },
    },
    { account: { account_id: 'account-1' } }
  );
  const result = evaluateReportingLedger(
    ledger,
    [
      {
        deliveryConfigId: 'billing-feed',
        deliveryConfigVersion: 1,
        periodStart: '2026-07-01T00:00:00Z',
        periodEnd: '2026-08-01T00:00:00Z',
      },
    ],
    new Date('2026-09-03T00:00:00Z')
  );
  assert.equal(result.definitive, false);
  assert.equal(result.missingExpectedPeriods.length, 1);
});

test('does not claim completeness without an independent expected-period denominator', async () => {
  const ledger = await loadReportingLedger(
    {
      async getReportingStatus() {
        return response([]);
      },
      async syncReportingReceipts() {
        throw new Error('not called');
      },
    },
    { account: { account_id: 'account-1' } }
  );
  const result = evaluateReportingLedger(ledger, undefined, new Date('2026-09-03T00:00:00Z'));
  assert.equal(result.definitive, false);
  assert.deepEqual(result.missingExpectedPeriods, []);
});

test('does not claim completeness when obligation history counts exceed returned records', async () => {
  const raw = response([]);
  raw.periods[0].revision_count = 2;
  const ledger = await loadReportingLedger(
    {
      async getReportingStatus() {
        return raw;
      },
      async syncReportingReceipts() {
        throw new Error('not called');
      },
    },
    { account: { account_id: 'account-1' } }
  );
  const result = evaluateReportingLedger(ledger, [], new Date('2026-09-03T00:00:00Z'));
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('ASSOCIATED_HISTORY_INCOMPLETE'));
});

test('deduplicates one canonical revision fanned out to two destinations', () => {
  const first = obligation('obligation-a');
  const second = obligation('obligation-b');
  for (const item of [first, second]) {
    item.reconciliation_mode = 'delivery_only';
    item.reconciliation_status = 'not_required';
    item.health = 'complete';
  }
  const ledger = {
    ledgerSnapshotId: 'snapshot-fanout',
    ledgerAsOf: '2026-09-02T00:00:06Z',
    accountId: 'account-1',
    scope: response([]).scope,
    obligations: [first, second],
    revisions: [revision],
    materializations: [
      materialization('materialization-a', 'obligation-a'),
      materialization('materialization-b', 'obligation-b'),
    ],
    receipts: [],
  };
  const result = evaluateReportingLedger(ledger, [], new Date('2026-09-03T00:00:00Z'));
  assert.equal(result.definitive, true);
  assert.equal(result.totalsByRevision.length, 1);
});

test('rejects producer-native evidence that does not identify the delivered version', () => {
  const item = obligation();
  item.reconciliation_mode = 'delivery_only';
  item.reconciliation_status = 'not_required';
  item.health = 'complete';
  const attempt = materialization();
  attempt.verification = {
    ...attempt.verification,
    verification_profile: 'native_commit',
    verification_path: 'representative_consumer',
    canonical_content_digest: undefined,
    native_commit_evidence: {
      native_version_ref: 'version-incorrect',
      observed_through: 'representative_consumer',
    },
  };
  const ledger = {
    ledgerSnapshotId: 'snapshot-native-mismatch',
    ledgerAsOf: '2026-09-02T00:00:06Z',
    accountId: 'account-1',
    scope: response([]).scope,
    obligations: [item],
    revisions: [revision],
    materializations: [attempt],
    receipts: [],
  };
  const result = evaluateReportingLedger(ledger, [], new Date('2026-09-03T00:00:00Z'));
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('PRODUCER_NATIVE_EVIDENCE_MISMATCH'));
});
