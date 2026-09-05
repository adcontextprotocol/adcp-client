const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildReportingReceipt,
  createHttpsReportingResourceReader,
  createReportingManifestInspector,
  evaluateReportingLedger,
  loadReportingLedger,
  reconcileReporting,
  ReportingInspectionError,
} = require('../dist/lib/index.js');
const { TOOL_RESPONSE_SCHEMAS } = require('../dist/lib/utils/response-schemas.js');

const period = {
  start: '2026-08-01T00:00:00Z',
  end: '2026-09-01T00:00:00Z',
  source_timezone: 'UTC',
};
const coverage = {
  status: 'full',
  evaluated_at: period.end,
  media_buy_ids: ['buy-1', 'buy-2'],
  fully_covered_media_buy_ids: ['buy-1', 'buy-2'],
  partially_covered_media_buy_ids: [],
  unsupported_media_buy_ids: [],
  unknown_media_buy_ids: [],
  package_ids: ['package-1', 'package-2'],
  covered_package_ids: ['package-1', 'package-2'],
  unsupported_package_ids: [],
  unknown_package_ids: [],
  limitations: [],
};
const totals = [
  { name: 'impressions', value: '4200', value_type: 'integer', unit: 'impressions' },
  { name: 'spend', value: '7000.00', value_type: 'decimal', unit: 'USD' },
];
const digest = {
  algorithm: 'sha256',
  value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  canonicalization_id: 'rows-v1',
  canonicalization_uri: 'https://schemas.example/canonicalization/rows-v1.json',
  canonicalization_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const revision = {
  reporting_revision_id: 'revision-august-official',
  revision_content_sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  report_definition_id: 'billing-v1',
  report_definition_uri: 'https://schemas.example/report-definitions/billing-v1.json',
  report_definition_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  reporting_profile: 'billing-v1',
  schema_version: '1',
  schema_uri: 'https://schemas.example/billing-v1.json',
  schema_sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  account_id: 'account-1',
  media_buy_ids: ['buy-1', 'buy-2'],
  coverage: structuredClone(coverage),
  period,
  finality: 'official',
  finality_basis: 'contractual_cutoff',
  finality_policy_id: 'billing-close-v1',
  finalized_at: '2026-09-02T00:00:00Z',
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
    scope_resolved_at: period.end,
    coverage: structuredClone(coverage),
    period,
    expected_at: '2026-09-02T00:00:00Z',
    schedule: {
      period_duration: 'P1M',
      alignment: 'billing_cycle',
      period_anchor: '2026-01-01T00:00:00Z',
      period_timezone: 'UTC',
      delivery_sla: 'P1D',
    },
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

function expectedPeriod(overrides = {}) {
  return {
    deliveryConfigId: 'billing-feed',
    deliveryConfigVersion: 1,
    reportDefinitionId: 'billing-v1',
    feedPurpose: 'billing',
    reportingProfile: 'billing-v1',
    mediaBuyIds: ['buy-1', 'buy-2'],
    destinationRef: 'destination-obligation-billing',
    deliveryMethod: 'dataset_share',
    requiredFinality: 'official',
    reconciliationMode: 'consumer_receipt',
    coverageRequirement: 'full',
    coverage: {
      status: coverage.status,
      media_buy_ids: coverage.media_buy_ids,
      fully_covered_media_buy_ids: coverage.fully_covered_media_buy_ids,
      partially_covered_media_buy_ids: coverage.partially_covered_media_buy_ids,
      unsupported_media_buy_ids: coverage.unsupported_media_buy_ids,
      unknown_media_buy_ids: coverage.unknown_media_buy_ids,
      package_ids: coverage.package_ids,
      covered_package_ids: coverage.covered_package_ids,
      unsupported_package_ids: coverage.unsupported_package_ids,
      unknown_package_ids: coverage.unknown_package_ids,
    },
    reportDefinitionUri: revision.report_definition_uri,
    reportDefinitionSha256: revision.report_definition_sha256,
    schemaVersion: revision.schema_version,
    schemaUri: revision.schema_uri,
    schemaSha256: revision.schema_sha256,
    schemaDialect: revision.schema_dialect,
    schemaRefPolicy: revision.schema_ref_policy,
    officialFinality: {
      policyId: revision.finality_policy_id,
      basis: revision.finality_basis,
    },
    verificationProfile: 'canonical_digest',
    canonicalization: {
      id: digest.canonicalization_id,
      uri: digest.canonicalization_uri,
      sha256: digest.canonicalization_sha256,
      primaryKeys: ['media_buy_id'],
    },
    periodStart: period.start,
    periodEnd: period.end,
    ...overrides,
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
      all_accessible_media_buys: true,
      delivery_config_generations: [
        { delivery_config_id: 'billing-feed', delivery_config_version: 1, feed_purpose: 'billing' },
      ],
      feed_purposes: ['billing'],
      finality: ['official'],
      ledger_retained_from: '2026-07-01T00:00:00Z',
      coverage_complete: true,
    },
    periods: [item],
    revisions: [structuredClone(revision)],
    materializations: [structuredClone(materialization())],
    receipts,
    pagination: { has_more: false, total_count: 3 + receipts.length },
  };
}

test('runtime response validation requires the current reporting evidence overlay', () => {
  const schema = TOOL_RESPONSE_SCHEMAS.get_reporting_status;
  const valid = response([]);
  valid.periods[0].health = 'action_required';
  valid.periods[0].issues = [
    {
      issue_id: 'receipt-required-billing',
      code: 'RECEIPT_REQUIRED',
      severity: 'action_required',
      responsible_party: 'buyer',
      recommended_action: 'wait_for_retry',
    },
  ];
  assert.equal(schema.safeParse(valid).success, true);

  const missingCoverage = response([]);
  delete missingCoverage.periods[0].coverage;
  assert.equal(schema.safeParse(missingCoverage).success, false);

  const invalidCoverageBoundary = response([]);
  delete invalidCoverageBoundary.periods[0].coverage.evaluated_at;
  assert.equal(schema.safeParse(invalidCoverageBoundary).success, false);

  const coverageWithExtraField = response([]);
  coverageWithExtraField.periods[0].coverage.untrusted_extra = true;
  assert.equal(schema.safeParse(coverageWithExtraField).success, false);

  const missingCanonicalizationUri = response([]);
  delete missingCanonicalizationUri.revisions[0].canonical_content_digest.canonicalization_uri;
  assert.equal(schema.safeParse(missingCanonicalizationUri).success, false);

  const missingMaterializations = response([]);
  delete missingMaterializations.materializations;
  assert.equal(schema.safeParse(missingMaterializations).success, false);

  const missingMediaBuyDenominator = response([]);
  delete missingMediaBuyDenominator.periods[0].media_buy_ids;
  assert.equal(schema.safeParse(missingMediaBuyDenominator).success, false);

  const invalidSchedule = response([]);
  invalidSchedule.periods[0].schedule.alignment = 'whenever';
  assert.equal(schema.safeParse(invalidSchedule).success, false);

  const missingProducerTotals = response([]);
  delete missingProducerTotals.materializations[0].verification.control_totals;
  assert.equal(schema.safeParse(missingProducerTotals).success, false);

  const optionalTransport = response([]);
  delete optionalTransport.materializations[0].transport;
  assert.equal(schema.safeParse(optionalTransport).success, true);

  const invalidControlTotal = response([]);
  invalidControlTotal.revisions[0].control_totals[0].value = 'NaN';
  assert.equal(schema.safeParse(invalidControlTotal).success, false);

  const currentCoverageIssue = response([]);
  currentCoverageIssue.periods[0].health = 'action_required';
  currentCoverageIssue.periods[0].issues = [
    {
      issue_id: 'coverage-incomplete-1',
      code: 'REPORTING_COVERAGE_INCOMPLETE',
      severity: 'action_required',
      responsible_party: 'seller',
      recommended_action: 'change_reporting_scope',
      message: 'The selected reporting offering does not cover the full denominator.',
    },
  ];
  const currentCoverageResult = schema.safeParse(currentCoverageIssue);
  assert.equal(currentCoverageResult.success, true, currentCoverageResult.error?.message);

  assert.equal(schema.safeParse({ status: 'completed', view: 'summary' }).success, false);
  const summary = response([]);
  summary.view = 'summary';
  delete summary.periods;
  delete summary.revisions;
  delete summary.materializations;
  delete summary.receipts;
  delete summary.pagination;
  summary.health = 'complete';
  summary.coverage = structuredClone(coverage);
  summary.data_through = null;
  summary.obligation_counts = {
    total: 1,
    waiting: 0,
    healthy: 0,
    delayed: 0,
    action_required: 0,
    complete: 1,
  };
  summary.issues = [];
  assert.equal(schema.safeParse(summary).success, true);
  assert.equal(schema.safeParse({ ...summary, periods: [] }).success, false);
  assert.equal(schema.safeParse({ ...summary, next_expected_at: '2026-09-04T00:00:00Z' }).success, false);

  const snapshotWithOfficialEvidence = response([]);
  snapshotWithOfficialEvidence.revisions[0].finality = 'snapshot';
  assert.equal(schema.safeParse(snapshotWithOfficialEvidence).success, false);

  assert.equal(
    schema.safeParse({
      status: 'failed',
      view: 'periods',
      failure_kind: 'operational',
      errors: [{ code: 'INTERNAL_ERROR', message: 'Reporting status failed.' }],
    }).success,
    true
  );
  assert.equal(
    schema.safeParse({
      status: 'failed',
      view: 'summary',
      failure_kind: 'lookup_unavailable',
      errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
      periods: [{ private: 'must not leak' }],
    }).success,
    false
  );
  assert.equal(
    schema.safeParse({
      status: 'failed',
      view: 'summary',
      failure_kind: 'lookup_unavailable',
      errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
    }).success,
    true
  );
});

test('rejects out-of-scope and orphan records before evaluating ledger completeness', async () => {
  const variants = [
    raw => {
      raw.revisions[0].control_totals[0].value = 'NaN';
      raw.materializations[0].verification.control_totals[0].value = 'NaN';
    },
    raw => {
      raw.revisions.push({
        ...structuredClone(revision),
        reporting_revision_id: 'orphan-cross-account',
        account_id: 'account-2',
      });
    },
    raw => {
      raw.materializations.push({
        ...structuredClone(materialization('orphan-materialization')),
        reporting_obligation_id: 'missing-obligation',
      });
    },
    raw => {
      raw.receipts.push({
        reporting_receipt_id: 'reporting-receipt:orphan',
        reporting_obligation_id: 'missing-obligation',
        reporting_revision_id: revision.reporting_revision_id,
        reporting_materialization_id: 'materialization-billing',
        status: 'accepted',
        verification_profile: 'canonical_digest',
        observed_row_count: revision.row_count,
        observed_control_totals: totals,
        observed_canonical_content_digest: digest,
        observed_at: '2026-09-02T00:01:00Z',
      });
    },
  ];

  for (const mutate of variants) {
    const raw = response([]);
    mutate(raw);
    raw.pagination.total_count =
      raw.periods.length + raw.revisions.length + raw.materializations.length + raw.receipts.length;
    await assert.rejects(
      loadReportingLedger(
        {
          async getReportingStatus() {
            return raw;
          },
        },
        { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } }
      ),
      error => error.code === 'LEDGER_GRAPH_INTEGRITY_FAILED'
    );
    assert.throws(
      () =>
        evaluateReportingLedger(
          {
            ledgerSnapshotId: raw.ledger_snapshot_id,
            ledgerAsOf: raw.ledger_as_of,
            accountId: raw.account_id,
            scope: raw.scope,
            obligations: raw.periods,
            revisions: raw.revisions,
            materializations: raw.materializations,
            receipts: raw.receipts,
          },
          [expectedPeriod()]
        ),
      error => error.code === 'LEDGER_GRAPH_INTEGRITY_FAILED'
    );
  }
});

test('rejects unbounded ledger loading and snapshot restart policies', async () => {
  const client = {
    async getReportingStatus() {
      throw new Error('must reject limits before transport');
    },
  };
  const request = { account: { account_id: 'account-1' } };
  const cases = [
    { restarts: -1, limits: {} },
    { restarts: 11, limits: {} },
    { restarts: 0, limits: { maxPages: 0 } },
    { restarts: 0, limits: { maxPages: Number.POSITIVE_INFINITY } },
    { restarts: 0, limits: { maxRecords: 1_000_001 } },
    { restarts: 0, limits: { maxLoadMs: Number.NaN } },
  ];

  for (const testCase of cases) {
    await assert.rejects(
      loadReportingLedger(client, request, testCase.restarts, testCase.limits),
      error => error.code === 'INVALID_LEDGER_LIMITS'
    );
  }
});

test('aborts a hung reporting-status request at the ledger deadline', async () => {
  let aborted = false;
  const client = {
    async getReportingStatus(_request, options) {
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('seller request aborted'));
          },
          { once: true }
        );
      });
    },
  };

  await assert.rejects(
    loadReportingLedger(client, { account: { account_id: 'account-1' } }, 0, { maxLoadMs: 20 }),
    error => error.code === 'LEDGER_LIMIT_EXCEEDED'
  );
  assert.equal(aborted, true);
});

test('aborts a hung receipt write at the reporting request deadline', async () => {
  let aborted = false;
  const client = {
    async getReportingStatus() {
      return response([]);
    },
    async syncReportingReceipts(_request, options) {
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('seller request aborted'));
          },
          { once: true }
        );
      });
    },
  };

  await assert.rejects(
    reconcileReporting({
      client,
      request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
      expectedPeriods: [expectedPeriod()],
      ledgerLimits: { maxLoadMs: 20 },
      now: new Date('2026-09-03T00:00:00Z'),
      async inspect() {
        return {
          rowCount: 7,
          controlTotals: totals,
          canonicalContentDigest: digest,
          consumerCommitRef: 'buyer-ledger-timeout',
        };
      },
    }),
    error => error.code === 'RECEIPT_WRITE_FAILED'
  );
  assert.equal(aborted, true);
});

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
    expectedPeriods: [expectedPeriod()],
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

  assert.equal(result.definitive, true, JSON.stringify(result.obligations));
  assert.equal(inspections, 2);
  assert.equal(result.submittedReceipts.length, 1);
  assert.equal(result.submittedReceipts[0].status, 'accepted');
  assert.deepEqual(result.totalsByRevision, [
    {
      reportingRevisionId: revision.reporting_revision_id,
      rowCount: 7,
      controlTotals: totals,
      coverageStatus: 'full',
      coveredPackageIds: ['package-1', 'package-2'],
      packageIds: ['package-1', 'package-2'],
    },
  ]);
});

test('records a rejected receipt when consumer billing evidence differs', () => {
  const raw = response([]);
  const receipt = buildReportingReceipt(
    {
      obligation: raw.periods[0],
      revision: raw.revisions[0],
      materialization: raw.materializations[0],
    },
    {
      rowCount: 8,
      controlTotals: [
        { name: 'impressions', value: '4199', value_type: 'integer', unit: 'impressions' },
        { name: 'spend', value: '7000.00', value_type: 'decimal', unit: 'USD' },
      ],
      canonicalContentDigest: { ...digest, value: 'd'.repeat(64) },
      consumerCommitRef: 'buyer-ledger-disputed-42',
    },
    'reporting-receipt:billing-dispute',
    '2026-09-02T00:01:00Z'
  );

  assert.equal(receipt.status, 'rejected');
  assert.deepEqual(receipt.rejection_codes, [
    'ROW_COUNT_MISMATCH',
    'CONTROL_TOTAL_MISMATCH',
    'CANONICAL_DIGEST_MISMATCH',
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
      expectedPeriod({
        deliveryMethod: 'file_transfer',
        periodStart: '2026-07-01T00:00:00Z',
        periodEnd: '2026-08-01T00:00:00Z',
      }),
    ],
    new Date('2026-09-03T00:00:00Z')
  );
  assert.equal(result.definitive, false);
  assert.equal(result.missingExpectedPeriods.length, 1);
});

test('does not accept a seller downgrade from consumer receipt to delivery only', () => {
  const raw = response([]);
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
  const ledger = {
    ledgerSnapshotId: raw.ledger_snapshot_id,
    ledgerAsOf: raw.ledger_as_of,
    accountId: raw.account_id,
    scope: raw.scope,
    obligations: raw.periods,
    revisions: raw.revisions,
    materializations: raw.materializations,
    receipts: raw.receipts,
  };
  const result = evaluateReportingLedger(ledger, [expectedPeriod()]);

  assert.equal(result.definitive, false);
  assert.equal(result.missingExpectedPeriods.length, 1);
});

test('does not let one campaign satisfy another campaign in the same feed period', async () => {
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
  const result = evaluateReportingLedger(ledger, [expectedPeriod({ mediaBuyIds: ['buy-1', 'buy-3'] })]);
  assert.equal(result.definitive, false);
  assert.equal(result.missingExpectedPeriods.length, 1);
});

test('rejects a revision whose campaign scope differs from its obligation', async () => {
  const raw = response([]);
  raw.revisions[0] = { ...raw.revisions[0], media_buy_ids: ['buy-1'] };
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
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
  const result = evaluateReportingLedger(ledger, [expectedPeriod()]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('REVISION_SCOPE_MISMATCH'));
});

test('rejects a period whose campaign denominator was not frozen at period end', async () => {
  const raw = response([]);
  raw.periods[0].scope_resolved_at = '2026-08-31T23:59:59Z';
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
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
  const result = evaluateReportingLedger(ledger, []);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('SCOPE_CUTOFF_MISMATCH'));
});

test('rejects full coverage whose package partition contains an unsupported package', async () => {
  const raw = response([]);
  for (const record of [raw.periods[0].coverage, raw.revisions[0].coverage]) {
    record.covered_package_ids = ['package-1'];
    record.unsupported_package_ids = ['package-2'];
  }
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

  const result = evaluateReportingLedger(ledger, [expectedPeriod()]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('COVERAGE_SCOPE_MISMATCH'));
});

for (const invalidCoverage of [
  {
    ...coverage,
    status: 'none',
    fully_covered_media_buy_ids: [],
    unsupported_media_buy_ids: ['buy-1'],
    unknown_media_buy_ids: ['buy-2'],
    covered_package_ids: [],
    unsupported_package_ids: ['package-1'],
    unknown_package_ids: ['package-2'],
  },
  {
    ...coverage,
    status: 'unknown',
    fully_covered_media_buy_ids: ['buy-1'],
    unknown_media_buy_ids: ['buy-2'],
    covered_package_ids: ['package-1'],
    unknown_package_ids: ['package-2'],
  },
  {
    ...coverage,
    limitations: [{ reason: 'provider_limitation', media_buy_id: 'buy-outside-denominator' }],
  },
]) {
  test(`rejects protocol-invalid ${invalidCoverage.status} coverage partitions and limitations`, async () => {
    const raw = response([]);
    raw.periods[0].coverage = structuredClone(invalidCoverage);
    raw.revisions[0].coverage = structuredClone(invalidCoverage);
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
    const expectedCoverage = structuredClone(invalidCoverage);
    delete expectedCoverage.evaluated_at;
    delete expectedCoverage.limitations;

    const result = evaluateReportingLedger(ledger, [expectedPeriod({ coverage: expectedCoverage })]);
    assert.equal(result.definitive, false);
    assert.ok(result.obligations[0].reasons.includes('COVERAGE_SCOPE_MISMATCH'));
  });
}

test('rejects a ledger returned for a different requested account', async () => {
  const raw = response([]);
  raw.account_id = 'account-attacker';
  await assert.rejects(
    loadReportingLedger(
      {
        async getReportingStatus() {
          return raw;
        },
        async syncReportingReceipts() {
          throw new Error('not called');
        },
      },
      { account: { account_id: 'account-1' } }
    ),
    error => error.code === 'ACCOUNT_SCOPE_MISMATCH'
  );
});

test('rejects a response denominator whose period differs from the request', async () => {
  const raw = response([]);
  raw.scope.period_start = '2026-08-02T00:00:00Z';
  await assert.rejects(
    loadReportingLedger(
      {
        async getReportingStatus() {
          return raw;
        },
        async syncReportingReceipts() {
          throw new Error('not called');
        },
      },
      { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } }
    ),
    error => error.code === 'REQUEST_SCOPE_MISMATCH'
  );
});

test('does not accept partial coverage for a full-coverage configuration', async () => {
  const raw = response([]);
  const partial = {
    ...coverage,
    status: 'partial',
    fully_covered_media_buy_ids: ['buy-1'],
    partially_covered_media_buy_ids: ['buy-2'],
    covered_package_ids: ['package-1'],
    unsupported_package_ids: ['package-2'],
  };
  raw.periods[0].coverage = structuredClone(partial);
  raw.revisions[0].coverage = structuredClone(partial);
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
  const expectedCoverage = structuredClone(partial);
  delete expectedCoverage.evaluated_at;
  delete expectedCoverage.limitations;

  const result = evaluateReportingLedger(ledger, [expectedPeriod({ coverage: expectedCoverage })]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('COVERAGE_REQUIREMENT_NOT_MET'));
});

test('rejects official data without auditable finality evidence', async () => {
  const raw = response([]);
  delete raw.revisions[0].finality_policy_id;
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
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
  const result = evaluateReportingLedger(ledger, []);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('FINALITY_NOT_MET'));
});

test('requires evidence on an official revision even when only snapshot finality was requested', async () => {
  const raw = response([]);
  raw.periods[0].required_finality = 'snapshot';
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
  delete raw.revisions[0].finality_policy_id;
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
  const result = evaluateReportingLedger(ledger, [
    expectedPeriod({ requiredFinality: 'snapshot', reconciliationMode: 'delivery_only' }),
  ]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('FINALITY_NOT_MET'));
});

test('binds official finality to the consumer-pinned policy and basis', async () => {
  const raw = response([]);
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
  const result = evaluateReportingLedger(ledger, [
    expectedPeriod({ officialFinality: { policyId: 'untrusted-policy', basis: 'source_final' } }),
  ]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('EXPECTED_FINALITY_POLICY_MISMATCH'));
});

test('rejects a revision whose semantic report definition is not pinned', async () => {
  const raw = response([]);
  delete raw.revisions[0].report_definition_sha256;
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
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
  const result = evaluateReportingLedger(ledger, []);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('REPORT_DEFINITION_NOT_PINNED'));
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
    revisions: [structuredClone(revision)],
    materializations: [
      materialization('materialization-a', 'obligation-a'),
      materialization('materialization-b', 'obligation-b'),
    ],
    receipts: [],
  };
  const result = evaluateReportingLedger(
    ledger,
    [
      expectedPeriod({ destinationRef: 'destination-obligation-a', reconciliationMode: 'delivery_only' }),
      expectedPeriod({ destinationRef: 'destination-obligation-b', reconciliationMode: 'delivery_only' }),
    ],
    new Date('2026-09-03T00:00:00Z')
  );
  assert.equal(result.definitive, true, JSON.stringify(result.obligations));
  assert.equal(result.totalsByRevision.length, 1);
});

test('requires expected periods and seller obligations to match bijectively', () => {
  const first = obligation();
  const duplicate = obligation('obligation-duplicate');
  duplicate.destination_ref = first.destination_ref;
  for (const item of [first, duplicate]) {
    item.reconciliation_mode = 'delivery_only';
    item.reconciliation_status = 'not_required';
    item.health = 'complete';
  }
  const duplicateMaterialization = materialization('materialization-duplicate', duplicate.reporting_obligation_id);
  duplicateMaterialization.destination_ref = first.destination_ref;
  const ledger = {
    ledgerSnapshotId: 'snapshot-duplicate-obligation',
    ledgerAsOf: '2026-09-02T00:00:06Z',
    accountId: 'account-1',
    scope: response([]).scope,
    obligations: [first, duplicate],
    revisions: [structuredClone(revision)],
    materializations: [materialization(), duplicateMaterialization],
    receipts: [],
  };

  const result = evaluateReportingLedger(ledger, [expectedPeriod({ reconciliationMode: 'delivery_only' })]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations.every(item => item.reasons.includes('EXPECTED_PERIOD_NOT_BIJECTIVE')));
});

test('does not inspect or submit receipts for a non-bijective expected period', async () => {
  let inspections = 0;
  let submissions = 0;
  const client = {
    async getReportingStatus() {
      return response([]);
    },
    async syncReportingReceipts() {
      submissions += 1;
      throw new Error('must not submit');
    },
  };
  const expected = expectedPeriod();
  const result = await reconcileReporting({
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [expected, structuredClone(expected)],
    async inspect() {
      inspections += 1;
      return { rowCount: 7, controlTotals: totals, canonicalContentDigest: digest };
    },
  });

  assert.equal(result.definitive, false);
  assert.equal(inspections, 0);
  assert.equal(submissions, 0);
  assert.ok(result.obligations[0].reasons.includes('EXPECTED_PERIOD_NOT_BIJECTIVE'));
});

test('does not inspect or submit a receipt through the wrong delivery method', async () => {
  let inspections = 0;
  let submissions = 0;
  const client = {
    async getReportingStatus() {
      return response([]);
    },
    async syncReportingReceipts() {
      submissions += 1;
      throw new Error('must not submit');
    },
  };
  const result = await reconcileReporting({
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [expectedPeriod({ deliveryMethod: 'warehouse_materialization' })],
    async inspect() {
      inspections += 1;
      return { rowCount: 7, controlTotals: totals, canonicalContentDigest: digest };
    },
  });

  assert.equal(result.definitive, false);
  assert.equal(inspections, 0);
  assert.equal(submissions, 0);
  assert.ok(result.obligations[0].reasons.includes('EXPECTED_DELIVERY_METHOD_MISMATCH'));
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

test('accepts a non-billing native-commit period without canonical digest evidence', () => {
  const item = obligation();
  item.feed_purpose = 'analytics';
  item.required_finality = 'snapshot';
  item.reconciliation_mode = 'delivery_only';
  item.reconciliation_status = 'not_required';
  item.health = 'complete';
  const snapshotRevision = structuredClone(revision);
  snapshotRevision.finality = 'snapshot';
  delete snapshotRevision.finality_basis;
  delete snapshotRevision.finality_policy_id;
  delete snapshotRevision.finalized_at;
  delete snapshotRevision.canonical_content_digest;
  const attempt = materialization();
  attempt.feed_purpose = 'analytics';
  attempt.verification = {
    verified_at: attempt.verification.verified_at,
    verification_path: 'representative_consumer',
    verification_profile: 'native_commit',
    row_count: snapshotRevision.row_count,
    control_totals: snapshotRevision.control_totals,
    native_commit_evidence: {
      native_version_ref: attempt.resource.native_version_ref,
      observed_through: 'representative_consumer',
    },
  };
  const ledger = {
    ledgerSnapshotId: 'snapshot-native-valid',
    ledgerAsOf: '2026-09-02T00:00:06Z',
    accountId: 'account-1',
    scope: response([]).scope,
    obligations: [item],
    revisions: [snapshotRevision],
    materializations: [attempt],
    receipts: [],
  };
  const result = evaluateReportingLedger(
    ledger,
    [
      expectedPeriod({
        feedPurpose: 'analytics',
        requiredFinality: 'snapshot',
        reconciliationMode: 'delivery_only',
        verificationProfile: 'native_commit',
        canonicalization: undefined,
      }),
    ],
    new Date('2026-09-03T00:00:00Z')
  );

  assert.equal(result.definitive, true, JSON.stringify(result.obligations));
});

for (const invalidMaterialization of [
  { method: 'file_transfer', resourceKind: 'dataset', verificationPath: 'representative_consumer' },
  { method: 'dataset_share', resourceKind: 'manifest', verificationPath: 'representative_consumer' },
  {
    method: 'warehouse_materialization',
    resourceKind: 'warehouse_relation',
    verificationPath: 'representative_consumer',
  },
]) {
  test(`rejects invalid ${invalidMaterialization.method} resource/path evidence`, () => {
    const item = obligation();
    item.reconciliation_mode = 'delivery_only';
    item.reconciliation_status = 'not_required';
    item.health = 'complete';
    const attempt = materialization();
    attempt.method = invalidMaterialization.method;
    attempt.resource.kind = invalidMaterialization.resourceKind;
    attempt.verification.verification_path = invalidMaterialization.verificationPath;
    attempt.verification.physical_checksums = [
      { object_ref: 'rows.jsonl', algorithm: 'sha256', value: 'a'.repeat(64) },
    ];
    const ledger = {
      ledgerSnapshotId: `snapshot-${invalidMaterialization.method}`,
      ledgerAsOf: '2026-09-02T00:00:06Z',
      accountId: 'account-1',
      scope: response([]).scope,
      obligations: [item],
      revisions: [structuredClone(revision)],
      materializations: [attempt],
      receipts: [],
    };
    const result = evaluateReportingLedger(ledger, [
      expectedPeriod({
        deliveryMethod: invalidMaterialization.method,
        reconciliationMode: 'delivery_only',
      }),
    ]);

    assert.equal(result.definitive, false);
    assert.ok(result.obligations[0].reasons.includes('MATERIALIZATION_METHOD_EVIDENCE_MISMATCH'));
  });
}

test('rejects successful materialization evidence without ready_at', () => {
  const raw = response([]);
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
  delete raw.materializations[0].ready_at;
  const ledger = {
    ledgerSnapshotId: raw.ledger_snapshot_id,
    ledgerAsOf: raw.ledger_as_of,
    accountId: raw.account_id,
    scope: raw.scope,
    obligations: raw.periods,
    revisions: raw.revisions,
    materializations: raw.materializations,
    receipts: raw.receipts,
  };
  const result = evaluateReportingLedger(ledger, [expectedPeriod({ reconciliationMode: 'delivery_only' })]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('MATERIALIZATION_METHOD_EVIDENCE_MISMATCH'));
});

test('rejects native-version resources without an immutable version reference', () => {
  const raw = response([]);
  raw.periods[0].reconciliation_mode = 'delivery_only';
  raw.periods[0].reconciliation_status = 'not_required';
  delete raw.materializations[0].resource.native_version_ref;
  const ledger = {
    ledgerSnapshotId: raw.ledger_snapshot_id,
    ledgerAsOf: raw.ledger_as_of,
    accountId: raw.account_id,
    scope: raw.scope,
    obligations: raw.periods,
    revisions: raw.revisions,
    materializations: raw.materializations,
    receipts: raw.receipts,
  };
  const result = evaluateReportingLedger(ledger, [expectedPeriod({ reconciliationMode: 'delivery_only' })]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('MATERIALIZATION_RESOURCE_EVIDENCE_MISMATCH'));
});

const reportingFixtureDir = path.join(__dirname, 'fixtures', 'reporting-reconciliation');
const reportingFixture = JSON.parse(fs.readFileSync(path.join(reportingFixtureDir, 'fixture.json'), 'utf8'));
const fixtureUrls = {
  'https://schemas.fixture.example.net/row-schema.json': 'row-schema.json',
  'https://schemas.fixture.example.net/report-definition.json': 'report-definition.json',
  'https://schemas.fixture.example.net/canonicalization.json': 'canonicalization.json',
};

function fixtureBytes(name) {
  return fs.readFileSync(path.join(reportingFixtureDir, name));
}

function fixtureResolver() {
  return {
    cache: { get() {}, set() {} },
    async resolve(ref) {
      const name = fixtureUrls[ref.uri];
      assert.ok(name, `unexpected fixture reference ${ref.uri}`);
      const body = fixtureBytes(name);
      assert.equal(ref.digest, `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`);
      return {
        ok: true,
        status: 'resolved',
        kind: 'generic',
        ref,
        cacheKey: `${ref.uri}@${ref.digest}`,
        fromCache: false,
        document: JSON.parse(body.toString('utf8')),
        body,
        text: body.toString('utf8'),
        contentType:
          name === 'row-schema.json'
            ? 'application/schema+json'
            : name === 'report-definition.json'
              ? 'application/vnd.adcp.reporting-definition+json'
              : 'application/vnd.adcp.reporting-canonicalization+json',
        httpStatus: 200,
      };
    },
  };
}

function fixtureLedgerResponse(receipts = []) {
  const raw = response(receipts);
  const expected = reportingFixture.expected;
  raw.revisions[0] = {
    ...raw.revisions[0],
    report_definition_uri: 'https://schemas.fixture.example.net/report-definition.json',
    report_definition_sha256: reportingFixture.files['report-definition.json'].sha256,
    schema_uri: 'https://schemas.fixture.example.net/row-schema.json',
    schema_sha256: reportingFixture.files['row-schema.json'].sha256,
    row_count: expected.row_count,
    control_totals: expected.control_totals,
    canonical_content_digest: {
      algorithm: 'sha256',
      value: expected.canonical_content_sha256,
      canonicalization_id: 'billing-rows-v1',
      canonicalization_uri: 'https://schemas.fixture.example.net/canonicalization.json',
      canonicalization_sha256: reportingFixture.files['canonicalization.json'].sha256,
    },
  };
  raw.materializations[0] = {
    ...raw.materializations[0],
    method: 'file_transfer',
    transport: 'https',
    resource: {
      resource_ref: 'fixture-resource',
      kind: 'manifest',
      location: 'https://bucket.fixture.example.net/reporting/manifest.json',
      manifest_version: '1.0',
      manifest_sha256: reportingFixture.files['manifest.json'].sha256,
      immutability: 'immutable_location',
      expires_at: '2026-12-01T00:00:00Z',
    },
    verification: {
      verified_at: '2026-09-02T00:00:05Z',
      verification_path: 'representative_consumer',
      verification_profile: 'canonical_digest',
      row_count: expected.row_count,
      control_totals: expected.control_totals,
      canonical_content_digest: raw.revisions[0].canonical_content_digest,
      physical_checksums: [
        {
          object_ref: 'rows.jsonl',
          algorithm: 'sha256',
          value: reportingFixture.files['rows.jsonl'].sha256,
        },
      ],
    },
  };
  return raw;
}

function fixtureExpectedPeriod() {
  return expectedPeriod({
    deliveryMethod: 'file_transfer',
    reportDefinitionUri: 'https://schemas.fixture.example.net/report-definition.json',
    reportDefinitionSha256: reportingFixture.files['report-definition.json'].sha256,
    schemaUri: 'https://schemas.fixture.example.net/row-schema.json',
    schemaSha256: reportingFixture.files['row-schema.json'].sha256,
    canonicalization: {
      id: 'billing-rows-v1',
      uri: 'https://schemas.fixture.example.net/canonicalization.json',
      sha256: reportingFixture.files['canonicalization.json'].sha256,
      primaryKeys: ['media_buy_id', 'date'],
    },
  });
}

test('rejects file-transfer manifests without immutable manifest pins', () => {
  const raw = fixtureLedgerResponse();
  delete raw.materializations[0].resource.manifest_sha256;
  const ledger = {
    ledgerSnapshotId: raw.ledger_snapshot_id,
    ledgerAsOf: raw.ledger_as_of,
    accountId: raw.account_id,
    scope: raw.scope,
    obligations: raw.periods,
    revisions: raw.revisions,
    materializations: raw.materializations,
    receipts: raw.receipts,
  };

  const result = evaluateReportingLedger(ledger, [fixtureExpectedPeriod()]);
  assert.equal(result.definitive, false);
  assert.ok(result.obligations[0].reasons.includes('MATERIALIZATION_METHOD_EVIDENCE_MISMATCH'));
});

function fixtureReader(options = {}) {
  return {
    attempts: 0,
    async read(request) {
      this.attempts += 1;
      assert.deepEqual(request.credential, { token: 'fixture-reader-token' });
      if (options.transientFirst && this.attempts === 1) {
        throw new ReportingInspectionError('RESOURCE_NOT_READY', 'manifest has not propagated', true);
      }
      if (options.missingObject && request.role === 'object') {
        throw new ReportingInspectionError('RESOURCE_READ_FAILED', 'complete manifest names a missing object', false);
      }
      const body = request.role === 'manifest' ? fixtureBytes('manifest.json') : fixtureBytes('rows.jsonl');
      if (options.corruptObject && request.role === 'object') body[0] ^= 1;
      return { body };
    },
  };
}

test('HTTPS reader binds credentials to a consumer-approved origin', async () => {
  const raw = fixtureLedgerResponse();
  const context = {
    obligation: raw.periods[0],
    revision: raw.revisions[0],
    materialization: raw.materializations[0],
  };
  let fetchCalls = 0;
  const reader = createHttpsReportingResourceReader({
    trustedFetchFn: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    },
  });

  await assert.rejects(
    reader.read({
      role: 'manifest',
      location: 'https://attacker.example.net/manifest.json',
      maxBytes: 1024,
      credential: {
        headers: { authorization: 'Bearer must-not-leak' },
        allowedOrigins: ['https://bucket.fixture.example.net'],
      },
      context,
    }),
    error => error instanceof ReportingInspectionError && error.code === 'RESOURCE_READ_FAILED' && !error.retryable
  );
  assert.equal(fetchCalls, 0);

  let forwardedAuthorization;
  const authorizedReader = createHttpsReportingResourceReader({
    trustedFetchFn: async (_url, init) => {
      forwardedAuthorization = new Headers(init.headers).get('authorization');
      return new Response('manifest bytes', { status: 200 });
    },
  });
  await authorizedReader.read({
    role: 'manifest',
    location: 'https://bucket.fixture.example.net/manifest.json',
    maxBytes: 1024,
    credential: {
      headers: { authorization: 'Bearer scoped-token' },
      allowedOrigins: ['https://bucket.fixture.example.net'],
    },
    context,
  });
  assert.equal(forwardedAuthorization, 'Bearer scoped-token');

  const mtlsReader = createHttpsReportingResourceReader({
    tls: { cert: 'client certificate' },
    tlsAllowedOrigins: ['https://bucket.fixture.example.net'],
  });
  await assert.rejects(
    mtlsReader.read({
      role: 'manifest',
      location: 'https://attacker.example.net/manifest.json',
      maxBytes: 1024,
      context,
    }),
    error => error instanceof ReportingInspectionError && error.code === 'RESOURCE_READ_FAILED'
  );

  await assert.rejects(
    reader.read({
      role: 'manifest',
      location: 'https://user:password@bucket.fixture.example.net/manifest.json',
      maxBytes: 1024,
      context,
    }),
    error => error instanceof ReportingInspectionError && error.code === 'RESOURCE_READ_FAILED'
  );
});

test('HTTPS reader treats an object missing after the manifest commit as permanent', async () => {
  const raw = fixtureLedgerResponse();
  const context = {
    obligation: raw.periods[0],
    revision: raw.revisions[0],
    materialization: raw.materializations[0],
  };
  const reader = createHttpsReportingResourceReader({
    trustedFetchFn: async () => new Response(null, { status: 404 }),
  });

  await assert.rejects(
    reader.read({
      role: 'object',
      location: 'https://bucket.fixture.example.net/manifest.json',
      objectRef: 'missing.jsonl',
      maxBytes: 1024,
      context,
    }),
    error => error instanceof ReportingInspectionError && error.code === 'RESOURCE_READ_FAILED' && !error.retryable
  );
});

test('uses the built-in reader to verify a manifest and submit a matching receipt', async () => {
  let recordedReceipt;
  const reader = fixtureReader({ transientFirst: true });
  const client = {
    async getReportingStatus() {
      return fixtureLedgerResponse(recordedReceipt ? [recordedReceipt] : []);
    },
    async syncReportingReceipts(request) {
      recordedReceipt = { ...request.receipts[0], received_at: '2026-09-02T00:01:00Z' };
      return { status: 'completed', results: [{ result: 'recorded', receipt: recordedReceipt }] };
    },
  };

  const result = await reconcileReporting({
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [fixtureExpectedPeriod()],
    now: new Date('2026-09-03T00:00:00Z'),
    resourceReader: reader,
    credentialProvider: {
      async getCredentials() {
        return { token: 'fixture-reader-token' };
      },
    },
    manifestInspectorOptions: {
      referenceResolver: fixtureResolver(),
      referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
      consumerCommitRef: 'fixture-consumer-commit',
    },
  });

  assert.equal(result.definitive, true, JSON.stringify(result.obligations));
  const retryScenario = reportingFixture.scenarios.find(scenario => scenario.id === 'retry');
  assert.equal(
    reader.attempts,
    retryScenario.expected_manifest_attempts + 1,
    'one transient manifest read plus manifest and object reads'
  );
  assert.equal(result.submittedReceipts[0].observed_manifest_sha256, reportingFixture.files['manifest.json'].sha256);
  assert.equal(
    result.submittedReceipts[0].observed_canonical_content_digest.value,
    reportingFixture.expected.canonical_content_sha256
  );
});

test('bounds a custom manifest reader with the aggregate inspection deadline', async () => {
  const raw = fixtureLedgerResponse();
  const inspect = createReportingManifestInspector({
    reader: {
      async read() {
        return new Promise(() => {});
      },
    },
    referenceResolver: fixtureResolver(),
    referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
    maxInspectionMs: 10,
  });

  await assert.rejects(
    inspect({
      obligation: raw.periods[0],
      revision: raw.revisions[0],
      materialization: raw.materializations[0],
      expected: fixtureExpectedPeriod(),
    }),
    error => error instanceof ReportingInspectionError && error.code === 'INSPECTION_TIMEOUT' && error.retryable
  );
});

test('enforces the decoded-byte cap after a custom decompressor returns', async () => {
  const raw = fixtureLedgerResponse();
  const inspect = createReportingManifestInspector({
    reader: fixtureReader(),
    credentialProvider: {
      async getCredentials() {
        return { token: 'fixture-reader-token' };
      },
    },
    referenceResolver: fixtureResolver(),
    referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
    compressionDecoders: { none: () => new Uint8Array(11) },
    maxDecodedObjectBytes: 10,
  });

  await assert.rejects(
    inspect({
      obligation: raw.periods[0],
      revision: raw.revisions[0],
      materialization: raw.materializations[0],
      expected: fixtureExpectedPeriod(),
    }),
    error => error instanceof ReportingInspectionError && error.code === 'RESOURCE_TOO_LARGE'
  );
});

test('requires the seller acknowledgement to echo the exact immutable receipt', async () => {
  const client = {
    async getReportingStatus() {
      return response([]);
    },
    async syncReportingReceipts(request) {
      return {
        status: 'completed',
        results: [
          {
            result: 'recorded',
            receipt: { ...request.receipts[0], observed_row_count: 999, received_at: '2026-09-02T00:01:00Z' },
          },
        ],
      };
    },
  };

  await assert.rejects(
    reconcileReporting({
      client,
      request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
      expectedPeriods: [expectedPeriod()],
      async inspect() {
        return { rowCount: 7, controlTotals: totals, canonicalContentDigest: digest };
      },
    }),
    error => error.code === 'RECEIPT_WRITE_FAILED'
  );
});

test('accepts SHA-512 producer evidence bound to a manifest object', async () => {
  const raw = fixtureLedgerResponse();
  raw.materializations[0].verification.physical_checksums = [
    {
      object_ref: 'rows.jsonl',
      algorithm: 'sha512',
      value: crypto.createHash('sha512').update(fixtureBytes('rows.jsonl')).digest('hex'),
    },
  ];
  const inspect = createReportingManifestInspector({
    reader: fixtureReader(),
    credentialProvider: {
      async getCredentials() {
        return { token: 'fixture-reader-token' };
      },
    },
    referenceResolver: fixtureResolver(),
    referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
  });

  const observation = await inspect({
    obligation: raw.periods[0],
    revision: raw.revisions[0],
    materialization: raw.materializations[0],
    expected: fixtureExpectedPeriod(),
  });
  assert.equal(observation.rowCount, reportingFixture.expected.row_count);
});

test('compares SHA-256 evidence by bytes regardless of hex casing', async () => {
  const raw = fixtureLedgerResponse();
  raw.revisions[0].canonical_content_digest.value = raw.revisions[0].canonical_content_digest.value.toUpperCase();
  raw.revisions[0].canonical_content_digest.canonicalization_sha256 =
    raw.revisions[0].canonical_content_digest.canonicalization_sha256.toUpperCase();
  raw.materializations[0].resource.manifest_sha256 = raw.materializations[0].resource.manifest_sha256.toUpperCase();
  raw.materializations[0].verification.canonical_content_digest = structuredClone(
    raw.revisions[0].canonical_content_digest
  );
  raw.materializations[0].verification.physical_checksums[0].value =
    raw.materializations[0].verification.physical_checksums[0].value.toUpperCase();
  const inspect = createReportingManifestInspector({
    reader: fixtureReader(),
    credentialProvider: {
      async getCredentials() {
        return { token: 'fixture-reader-token' };
      },
    },
    referenceResolver: fixtureResolver(),
    referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
  });
  const context = {
    obligation: raw.periods[0],
    revision: raw.revisions[0],
    materialization: raw.materializations[0],
    expected: fixtureExpectedPeriod(),
  };
  const observation = await inspect(context);
  const receipt = buildReportingReceipt(context, observation);

  assert.equal(receipt.status, 'accepted');
});

for (const scenario of reportingFixture.scenarios.filter(item => item.expected_error)) {
  test(`portable inspection fixture: ${scenario.id}`, async () => {
    const raw = fixtureLedgerResponse();
    const readerOptions = {};
    if (scenario.mutation === 'reader_missing_object') readerOptions.missingObject = true;
    if (scenario.mutation === 'corrupt_object_bytes') readerOptions.corruptObject = true;
    if (scenario.mutation === 'increment_revision_row_count') raw.revisions[0].row_count += 1;
    if (scenario.mutation === 'increment_revision_impressions') {
      raw.revisions[0].control_totals = raw.revisions[0].control_totals.map(total =>
        total.name === 'impressions' ? { ...total, value: String(Number(total.value) + 1) } : total
      );
    }
    if (scenario.mutation === 'replace_revision_canonical_digest') {
      raw.revisions[0].canonical_content_digest.value = 'e'.repeat(64);
    }
    const inspect = createReportingManifestInspector({
      reader: fixtureReader(readerOptions),
      credentialProvider: {
        async getCredentials() {
          return { token: 'fixture-reader-token' };
        },
      },
      referenceResolver: fixtureResolver(),
      referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
    });

    await assert.rejects(
      inspect({
        obligation: raw.periods[0],
        revision: raw.revisions[0],
        materialization: raw.materializations[0],
        expected: fixtureExpectedPeriod(),
      }),
      error =>
        error instanceof ReportingInspectionError &&
        error.code === scenario.expected_error.code &&
        error.retryable === scenario.expected_error.retryable
    );
  });
}

test('portable inspection fixture: checkpoint avoids rereading after a receipt write failure', async () => {
  let checkpoint;
  let checkpointKey;
  let recordedReceipt;
  let syncAttempts = 0;
  const syncIdempotencyKeys = [];
  const reader = fixtureReader();
  const checkpointStore = {
    async get(key) {
      if (checkpointKey) assert.deepEqual(key, checkpointKey);
      return checkpoint;
    },
    async put(key, value) {
      checkpointKey = structuredClone(key);
      checkpoint = structuredClone(value);
    },
  };
  const client = {
    async getReportingStatus() {
      return fixtureLedgerResponse(recordedReceipt ? [recordedReceipt] : []);
    },
    async syncReportingReceipts(request) {
      syncAttempts += 1;
      syncIdempotencyKeys.push(request.idempotency_key);
      if (syncAttempts === 1) throw new Error('simulated receipt transport failure');
      recordedReceipt = { ...request.receipts[0], received_at: '2026-09-02T00:01:00Z' };
      return { status: 'completed', results: [{ result: 'recorded', receipt: recordedReceipt }] };
    },
  };
  const options = {
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [fixtureExpectedPeriod()],
    checkpointStore,
    checkpointScope: 'seller.example.net:buyer-principal-1',
    resourceReader: reader,
    credentialProvider: {
      async getCredentials() {
        return { token: 'fixture-reader-token' };
      },
    },
    manifestInspectorOptions: {
      referenceResolver: fixtureResolver(),
      referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
    },
  };

  await assert.rejects(reconcileReporting(options), /simulated receipt transport failure/);
  const readsAfterCheckpoint = reader.attempts;
  const result = await reconcileReporting(options);
  const checkpointScenario = reportingFixture.scenarios.find(scenario => scenario.id === 'checkpoint');

  assert.equal(readsAfterCheckpoint, checkpointScenario.expected_resource_reads);
  assert.equal(reader.attempts, readsAfterCheckpoint);
  assert.equal(result.submittedReceipts.length, 1);
  assert.equal(syncAttempts, 2);
  assert.equal(new Set(syncIdempotencyKeys).size, 1);
});

test('portable inspection fixture: checkpoint is invalidated when immutable evidence changes', async () => {
  let checkpoint;
  let changedLocation = false;
  let recordedReceipt;
  let syncAttempts = 0;
  const reader = fixtureReader();
  const checkpointStore = {
    async get() {
      return checkpoint;
    },
    async put(_key, value) {
      checkpoint = structuredClone(value);
    },
  };
  const client = {
    async getReportingStatus() {
      const raw = fixtureLedgerResponse(recordedReceipt ? [recordedReceipt] : []);
      if (changedLocation) raw.materializations[0].resource.location = 'https://files.fixture.example.net/moved.json';
      return raw;
    },
    async syncReportingReceipts(request) {
      syncAttempts += 1;
      if (syncAttempts === 1) {
        changedLocation = true;
        throw new Error('simulated ambiguous receipt transport failure');
      }
      recordedReceipt = { ...request.receipts[0], received_at: '2026-09-02T00:01:00Z' };
      return { status: 'completed', results: [{ result: 'recorded', receipt: recordedReceipt }] };
    },
  };
  const options = {
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [fixtureExpectedPeriod()],
    checkpointStore,
    checkpointScope: 'seller.example.net:buyer-principal-1',
    resourceReader: reader,
    credentialProvider: {
      async getCredentials() {
        return { token: 'fixture-reader-token' };
      },
    },
    manifestInspectorOptions: {
      referenceResolver: fixtureResolver(),
      referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
    },
  };

  await assert.rejects(reconcileReporting(options), /simulated ambiguous receipt transport failure/);
  const readsBeforeMutation = reader.attempts;
  await reconcileReporting(options);

  assert.match(checkpoint.contextFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(reader.attempts > readsBeforeMutation, 'changed immutable context must be inspected again');
  assert.equal(syncAttempts, 2);
});

test('portable inspection fixture: observed row mismatch submits one exact rejected receipt', async () => {
  let recordedReceipt;
  const scenario = reportingFixture.scenarios.find(item => item.id === 'rejected_receipt');
  assert.equal(scenario.mutation, 'replace_observed_row_count');
  const client = {
    async getReportingStatus() {
      return fixtureLedgerResponse(recordedReceipt ? [recordedReceipt] : []);
    },
    async syncReportingReceipts(request) {
      recordedReceipt = { ...request.receipts[0], received_at: '2026-09-02T00:01:00Z' };
      return { status: 'completed', results: [{ result: 'recorded', receipt: recordedReceipt }] };
    },
  };

  const result = await reconcileReporting({
    client,
    request: { account: { account_id: 'account-1' }, period: { start: period.start, end: period.end } },
    expectedPeriods: [fixtureExpectedPeriod()],
    async inspect(context) {
      return {
        rowCount: context.revision.row_count + 1,
        controlTotals: context.revision.control_totals,
        canonicalContentDigest: context.revision.canonical_content_digest,
        manifestSha256: context.materialization.resource.manifest_sha256,
      };
    },
  });

  assert.equal(result.definitive, false, 'a rejected receipt cannot make the obligation definitive');
  assert.equal(result.submittedReceipts[0].status, 'rejected');
  assert.deepEqual(result.submittedReceipts[0].rejection_codes, ['ROW_COUNT_MISMATCH']);
});
