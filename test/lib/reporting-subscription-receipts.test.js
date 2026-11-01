/**
 * The buyer receipts policy (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): receipts are
 * sent only after the SDK verified the revision and the buyer's commit returned a ref; adjustments are
 * never accepted automatically.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { ReportingClient, validateReceiptPolicy } = require('@adcp/sdk');
const { applyReceiptPolicy, emptyReceiptReport } = require('../../dist/lib/principal/reporting-receipts.js');
const { createReportingTestKit, offerings, reportingTestStart } = require('../../dist/lib/testing/reporting/index.js');

const period = { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z', source_timezone: 'UTC' };
const coverage = {
  status: 'full',
  evaluated_at: period.end,
  media_buy_ids: ['buy-1'],
  fully_covered_media_buy_ids: ['buy-1'],
  partially_covered_media_buy_ids: [],
  unsupported_media_buy_ids: [],
  unknown_media_buy_ids: [],
  package_ids: ['package-1'],
  covered_package_ids: ['package-1'],
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
  value: 'a'.repeat(64),
  canonicalization_id: 'rows-v1',
  canonicalization_uri: 'https://schemas.example/canonicalization/rows-v1.json',
  canonicalization_sha256: 'b'.repeat(64),
};
const revision = {
  reporting_revision_id: 'revision-august-official',
  revision_content_sha256: 'e'.repeat(64),
  report_definition_id: 'billing-v1',
  report_definition_uri: 'https://schemas.example/report-definitions/billing-v1.json',
  report_definition_sha256: 'd'.repeat(64),
  reporting_profile: 'billing-v1',
  schema_version: '1',
  schema_uri: 'https://schemas.example/billing-v1.json',
  schema_sha256: 'c'.repeat(64),
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  account_id: 'account-1',
  media_buy_ids: ['buy-1'],
  coverage,
  period,
  finality: 'official',
  finality_basis: 'contractual_cutoff',
  finality_policy_id: 'billing-close-v1',
  finalized_at: '2026-09-02T00:00:00Z',
  observed_at: '2026-09-02T00:00:00Z',
  data_through: period.end,
  data_through_precision: 'exact',
  row_count: 7,
  control_totals: totals,
  canonical_content_digest: digest,
  created_at: '2026-09-02T00:00:00Z',
};
const obligation = {
  reporting_obligation_id: 'obligation-billing',
  delivery_config_id: 'billing-feed',
  delivery_config_version: 1,
  report_definition_id: 'billing-v1',
  feed_purpose: 'billing',
  reporting_profile: 'billing-v1',
  account_id: 'account-1',
  media_buy_ids: ['buy-1'],
  scope_resolved_at: period.end,
  coverage,
  period,
  expected_at: '2026-09-02T00:00:00Z',
  destination_ref: 'destination-billing',
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
};
const materialization = {
  reporting_materialization_id: 'materialization-billing',
  reporting_revision_id: revision.reporting_revision_id,
  reporting_obligation_id: obligation.reporting_obligation_id,
  delivery_config_id: 'billing-feed',
  delivery_config_version: 1,
  destination_ref: 'destination-billing',
  feed_purpose: 'billing',
  method: 'dataset_share',
  transport: 'delta_sharing',
  attempt: 1,
  status: 'available',
  ready_at: '2026-09-02T00:00:05Z',
  resource: {
    resource_ref: 'resource-billing',
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
const adjustment = {
  reporting_adjustment_id: 'adjustment-august-1',
  adjusts_reporting_revision_id: revision.reporting_revision_id,
  reason_code: 'late_attribution',
  accounting_period: { start: period.start, end: period.end },
  control_total_deltas: [{ name: 'impressions', value: '12', value_type: 'integer', unit: 'impressions' }],
  correction_observed_at: '2026-09-02T01:00:00Z',
  created_at: '2026-09-02T01:00:01Z',
};

const ledger = (overrides = {}) => ({
  ledgerSnapshotId: 'snapshot-1',
  ledgerAsOf: '2026-09-02T00:00:06Z',
  accountId: 'account-1',
  scope: {},
  obligations: [structuredClone(obligation)],
  revisions: [structuredClone(revision)],
  materializations: [structuredClone(materialization)],
  receipts: [],
  ...overrides,
});
const matching = async () => ({
  rowCount: 7,
  controlTotals: structuredClone(totals),
  canonicalContentDigest: structuredClone(digest),
});
const NOW = Date.parse('2026-09-03T00:00:00Z');

function writer() {
  const writes = [];
  return {
    writes,
    syncReportingReceipts: async params => {
      writes.push(params);
      return { success: true, data: { status: 'completed', receipts: [] } };
    },
  };
}

describe('the receipts policy', () => {
  test('is validated before anything is read', () => {
    validateReceiptPolicy(undefined);
    validateReceiptPolicy({ mode: 'off' });
    assert.throws(() => validateReceiptPolicy({ mode: 'auto' }), { code: 'INVALID_REQUEST', dispatched: false });
    assert.throws(() => validateReceiptPolicy({ mode: 'verified', inspect: matching }), /needs commit/);
    assert.throws(() => validateReceiptPolicy({ mode: 'verified', commit: () => 'defer' }), /exactly one of/);
    assert.throws(
      () => validateReceiptPolicy({ mode: 'verified', commit: () => 'defer', resourceReader: {} }),
      /referenceAllowedOrigins/
    );
  });

  test('a commit ref yields an accepted receipt carrying it; once receipted nothing is resent', async () => {
    const client = writer();
    const report = emptyReceiptReport();
    const seen = [];
    const policy = {
      mode: 'verified',
      inspect: matching,
      commit: async verified => {
        seen.push(verified);
        return { commitRef: 'load-17' };
      },
    };
    assert.equal(await applyReceiptPolicy(client, 'account-1', ledger(), policy, report, NOW), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].accountId, 'account-1');
    assert.equal(seen[0].resource.native_version_ref, 'version-42');
    const [receipt] = report.submitted;
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.consumer_commit_ref, 'load-17');
    assert.match(receipt.reporting_receipt_id, /^reporting-receipt:[0-9a-f]{40}$/);
    assert.equal(client.writes.length, 1);
    assert.deepEqual(client.writes[0].account, { account_id: 'account-1' });
    assert.match(client.writes[0].idempotency_key, /^rrcpt-/);

    // The same materialization, now receipted: nothing is sent, commit is not called.
    const again = emptyReceiptReport();
    const receipted = ledger({ receipts: [receipt] });
    receipted.obligations[0].receipt_count = 1;
    receipted.obligations[0].accepted_receipt_count = 1;
    assert.equal(await applyReceiptPolicy(client, 'account-1', receipted, policy, again, NOW), false);
    assert.equal(seen.length, 1);

    // The receipt id is stable per (obligation, revision, materialization).
    const third = emptyReceiptReport();
    await applyReceiptPolicy(writer(), 'account-1', ledger(), policy, third, NOW);
    assert.equal(third.submitted[0].reporting_receipt_id, receipt.reporting_receipt_id);
  });

  test("'defer' sends nothing, and { reject } sends your codes", async () => {
    const deferred = emptyReceiptReport();
    const client = writer();
    await applyReceiptPolicy(
      client,
      'account-1',
      ledger(),
      { mode: 'verified', inspect: matching, commit: () => 'defer' },
      deferred,
      NOW
    );
    assert.deepEqual(deferred.deferred, ['obligation-billing']);
    assert.equal(client.writes.length, 0);

    const rejected = emptyReceiptReport();
    await applyReceiptPolicy(
      client,
      'account-1',
      ledger(),
      { mode: 'verified', inspect: matching, commit: () => ({ reject: ['WAREHOUSE_SCHEMA_DRIFT'] }) },
      rejected,
      NOW
    );
    assert.equal(rejected.rejected[0].status, 'rejected');
    assert.deepEqual(rejected.rejected[0].rejection_codes, ['WAREHOUSE_SCHEMA_DRIFT']);
    assert.equal(client.writes.length, 1);
  });

  test('a mismatch the SDK finds is rejected without calling commit; a failed read or commit receipts nothing', async () => {
    let commits = 0;
    const commit = () => {
      commits += 1;
      return { commitRef: 'never' };
    };
    const mismatch = emptyReceiptReport();
    await applyReceiptPolicy(
      writer(),
      'account-1',
      ledger(),
      { mode: 'verified', inspect: async () => ({ ...(await matching()), rowCount: 6 }), commit },
      mismatch,
      NOW
    );
    assert.equal(commits, 0);
    assert.deepEqual(mismatch.rejected[0].rejection_codes, ['ROW_COUNT_MISMATCH']);

    const unreadable = emptyReceiptReport();
    const client = writer();
    const failing = async () => {
      throw Object.assign(new Error('gone'), { code: 'RESOURCE_UNAVAILABLE' });
    };
    await applyReceiptPolicy(
      client,
      'account-1',
      ledger(),
      { mode: 'verified', inspect: failing, commit },
      unreadable,
      NOW
    );
    assert.deepEqual(unreadable.failed, [['obligation-billing', 'RESOURCE_UNAVAILABLE']]);

    const crashed = emptyReceiptReport();
    await applyReceiptPolicy(
      client,
      'account-1',
      ledger(),
      {
        mode: 'verified',
        inspect: matching,
        commit: () => {
          throw new Error('warehouse down');
        },
      },
      crashed,
      NOW
    );
    assert.deepEqual(crashed.failed, [['obligation-billing', 'COMMIT_FAILED']]);
    assert.equal(client.writes.length, 0);
  });

  test('adjustments are offered and always deferred, even after the revision was receipted', async () => {
    const offered = [];
    const report = emptyReceiptReport();
    const warn = console.warn;
    const warnings = [];
    console.warn = message => warnings.push(message);
    const receipted = ledger({
      adjustments: [adjustment],
      receipts: [
        {
          reporting_obligation_id: 'obligation-billing',
          reporting_revision_id: revision.reporting_revision_id,
          reporting_materialization_id: 'materialization-billing',
          status: 'accepted',
        },
      ],
    });
    Object.assign(receipted.obligations[0], { receipt_count: 1, accepted_receipt_count: 1 });
    try {
      await applyReceiptPolicy(
        writer(),
        'account-1',
        receipted,
        {
          mode: 'verified',
          inspect: matching,
          commit: () => 'defer',
          adjustments: item => {
            offered.push(item.reporting_adjustment_id);
            return 'accept';
          },
        },
        report,
        NOW
      );
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(offered, ['adjustment-august-1']);
    assert.deepEqual(report.adjustmentsDeferred, ['adjustment-august-1']);
    assert.match(warnings.join('\n'), /applies only 'defer'/);
  });

  test("'off' submits nothing", async () => {
    const client = writer();
    assert.equal(
      await applyReceiptPolicy(client, 'account-1', ledger(), { mode: 'off' }, emptyReceiptReport(), NOW),
      false
    );
    assert.equal(client.writes.length, 0);
  });
});

describe('client.reporting.submitReceipts and reconcile({ receipts })', () => {
  test('submitReceipts wraps sync_reporting_receipts and refuses an empty call', async () => {
    const client = writer();
    const reporting = new ReportingClient({ ...client, getPrincipal: async () => ({ success: true, data: {} }) });
    await assert.rejects(reporting.submitReceipts('account-1', {}), { code: 'INVALID_REQUEST', dispatched: false });
    const result = await reporting.submitReceipts('account-1', {
      adjustmentReceipts: [{ reporting_adjustment_id: 'a' }],
    });
    assert.deepEqual(result, { receipts: [], adjustmentReceipts: [] });
    assert.deepEqual(client.writes[0].adjustment_receipts, [{ reporting_adjustment_id: 'a' }]);
    const failing = new ReportingClient({
      getPrincipal: async () => ({ success: true, data: {} }),
      syncReportingReceipts: async () => ({ success: false, error: 'nope' }),
    });
    await assert.rejects(failing.submitReceipts('account-1', { receipts: [{}] }), { code: 'RECEIPT_WRITE_FAILED' });
  });

  test('reconcile carries report.receipts only with a verified policy', async () => {
    const START = reportingTestStart(30);
    const day = n => new Date(Date.parse(START) + n * 86_400_000).toISOString();
    const kit = createReportingTestKit({
      start: START,
      offerings: [offerings.dailyAnalytics()],
      accounts: [{ account_id: 'acc_a', timezone: 'UTC', grants: ['agency-x'] }],
      buys: [
        { media_buy_id: 'mb_1', account_id: 'acc_a', confirmed_at: day(0.5), start_time: day(1), end_time: day(25) },
      ],
    });
    const buyer = kit.buyer('agency-x');
    await buyer.reporting.subscribe({
      subscription_id: 'analytics-daily',
      scope: { all_authorized_accounts: true },
      selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
      reconciliation_mode: 'delivery_only',
    });
    await kit.clock.advance('P3D');
    const off = await buyer.reporting.reconcile({ now: kit.clock.now() });
    assert.equal(off.receipts, undefined);
    assert.ok(
      off.periods.every(line => line.receipt === undefined),
      'delivery_only periods owe no receipt'
    );
    const verified = await buyer.reporting.reconcile({
      now: kit.clock.now(),
      receipts: { mode: 'verified', inspect: matching, commit: () => ({ commitRef: 'x' }) },
    });
    assert.deepEqual(verified.receipts, {
      submitted: [],
      rejected: [],
      deferred: [],
      failed: [],
      adjustmentsDeferred: [],
      owedByBuyer: 0,
    });
    await assert.rejects(buyer.reporting.reconcile({ receipts: { mode: 'verified', inspect: matching } }), {
      code: 'INVALID_REQUEST',
      dispatched: false,
    });
  });
});
