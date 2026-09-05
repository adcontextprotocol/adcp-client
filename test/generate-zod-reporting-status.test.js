const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const RefParser = require('@apidevtools/json-schema-ref-parser').default;
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const REPO_ROOT = path.resolve(__dirname, '..');
const RESPONSE_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'schemas/cache/latest/bundled/media-buy/get-reporting-status-response.json'
);
const GENERATED_SCHEMAS_PATH = path.join(REPO_ROOT, 'src/lib/types/schemas.generated.ts');

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
const digest = {
  algorithm: 'sha256',
  value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  canonicalization_id: 'rows-v1',
  canonicalization_uri: 'https://schemas.example/canonicalization/rows-v1.json',
  canonicalization_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const totals = [{ name: 'impressions', value: '4200', value_type: 'integer', unit: 'impressions' }];

function response() {
  return {
    status: 'completed',
    view: 'periods',
    ledger_snapshot_id: 'snapshot-1',
    ledger_as_of: '2026-09-02T00:00:06Z',
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
    periods: [
      {
        reporting_obligation_id: 'obligation-billing',
        delivery_config_id: 'billing-feed',
        delivery_config_version: 1,
        report_definition_id: 'billing-v1',
        feed_purpose: 'billing',
        reporting_profile: 'billing-v1',
        account_id: 'account-1',
        media_buy_ids: ['buy-1', 'buy-2'],
        scope_resolved_at: period.end,
        coverage: structuredClone(coverage),
        period: structuredClone(period),
        expected_at: '2026-09-02T00:00:00Z',
        schedule: {
          period_duration: 'P1M',
          alignment: 'billing_cycle',
          period_anchor: period.start,
          period_timezone: 'UTC',
          delivery_sla: 'P1D',
        },
        destination_ref: 'destination-obligation-billing',
        required_finality: 'official',
        reconciliation_mode: 'consumer_receipt',
        reconciliation_status: 'pending',
        health: 'action_required',
        production_status: 'published',
        revision_count: 1,
        materialization_count: 1,
        successful_materialization_count: 1,
        receipt_count: 0,
        accepted_receipt_count: 0,
        issues: [
          {
            issue_id: 'receipt-required-billing',
            code: 'RECEIPT_REQUIRED',
            severity: 'action_required',
            responsible_party: 'buyer',
            recommended_action: 'wait_for_retry',
          },
        ],
        resource_retained_until: '2026-12-01T00:00:00Z',
      },
    ],
    revisions: [
      {
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
        period: structuredClone(period),
        finality: 'official',
        finality_basis: 'contractual_cutoff',
        finality_policy_id: 'billing-close-v1',
        finalized_at: '2026-09-02T00:00:00Z',
        observed_at: '2026-09-02T00:00:00Z',
        data_through: period.end,
        data_through_precision: 'exact',
        row_count: 7,
        control_totals: structuredClone(totals),
        canonical_content_digest: structuredClone(digest),
        created_at: '2026-09-02T00:00:00Z',
      },
    ],
    materializations: [
      {
        reporting_materialization_id: 'materialization-billing',
        reporting_revision_id: 'revision-august-official',
        reporting_obligation_id: 'obligation-billing',
        delivery_config_id: 'billing-feed',
        delivery_config_version: 1,
        destination_ref: 'destination-obligation-billing',
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
          control_totals: structuredClone(totals),
          canonical_content_digest: structuredClone(digest),
        },
        created_at: '2026-09-02T00:00:01Z',
      },
    ],
    receipts: [
      {
        reporting_receipt_id: 'receipt-billing-01',
        reporting_obligation_id: 'obligation-billing',
        reporting_revision_id: 'revision-august-official',
        reporting_materialization_id: 'materialization-billing',
        status: 'accepted',
        verification_profile: 'canonical_digest',
        observed_row_count: 7,
        observed_control_totals: structuredClone(totals),
        observed_canonical_content_digest: structuredClone(digest),
        observed_at: '2026-09-02T00:00:10Z',
      },
    ],
    pagination: { has_more: false, total_count: 4 },
  };
}

function summaryResponse() {
  const periodsResponse = response();
  return {
    status: 'completed',
    view: 'summary',
    ledger_snapshot_id: periodsResponse.ledger_snapshot_id,
    ledger_as_of: periodsResponse.ledger_as_of,
    account_id: periodsResponse.account_id,
    scope: periodsResponse.scope,
    health: 'healthy',
    coverage: structuredClone(coverage),
    data_through: period.end,
    obligation_counts: {
      total: 1,
      waiting: 0,
      healthy: 1,
      delayed: 0,
      action_required: 0,
      complete: 0,
    },
    issues: [],
  };
}

function revisionResponse() {
  const periodsResponse = response();
  return {
    status: 'completed',
    view: 'revision',
    ledger_snapshot_id: periodsResponse.ledger_snapshot_id,
    ledger_as_of: periodsResponse.ledger_as_of,
    account_id: periodsResponse.account_id,
    revision: periodsResponse.revisions[0],
    materializations: periodsResponse.materializations,
    receipts: periodsResponse.receipts,
    pagination: periodsResponse.pagination,
  };
}

function manifestChecksumsResponse() {
  const periodsResponse = response();
  periodsResponse.materializations[0].feed_purpose = 'analytics';
  periodsResponse.materializations[0].verification = {
    ...periodsResponse.materializations[0].verification,
    verification_profile: 'manifest_checksums',
    physical_checksums: [
      {
        object_ref: 'share.billing/manifest.json',
        algorithm: 'sha256',
        value: digest.value,
      },
    ],
  };
  delete periodsResponse.materializations[0].verification.canonical_content_digest;
  return periodsResponse;
}

function removeNestedIds(value, root = true, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value) && !root) delete value.$id;
  Object.values(value).forEach(child => removeNestedIds(child, false, seen));
}

async function authoritativeValidator() {
  assert.ok(
    fs.existsSync(RESPONSE_SCHEMA_PATH),
    'reporting-status schema cache is required; run npm run sync-schemas before this test'
  );
  const source = await RefParser.dereference(RESPONSE_SCHEMA_PATH);
  // Dereferencing preserves source $ids on repeated inlined documents. Ajv
  // rightfully rejects duplicate identifiers, so retain only the root id.
  removeNestedIds(source);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(source);
}

function generatedOutcomes(cases) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-reporting-status-runtime-'));
  const inputPath = path.join(harnessDir, 'cases.json');
  const outputPath = path.join(harnessDir, 'out.json');
  const scriptPath = path.join(harnessDir, 'harness.ts');
  fs.writeFileSync(inputPath, JSON.stringify(cases));
  fs.writeFileSync(
    scriptPath,
    `
import { readFileSync, writeFileSync } from 'node:fs';
import { GetReportingStatusResponseSchema } from ${JSON.stringify(GENERATED_SCHEMAS_PATH)};
const cases = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(cases.map(value => GetReportingStatusResponseSchema.safeParse(value).success)));
`
  );
  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `generated Zod harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

test('generated reporting-status Zod matches authoritative required and closed evidence boundaries for every view', async () => {
  const valid = response();
  const missingMaterializations = response();
  delete missingMaterializations.materializations;
  const missingCoverage = response();
  delete missingCoverage.periods[0].coverage;
  const missingCoverageTimestamp = response();
  delete missingCoverageTimestamp.periods[0].coverage.evaluated_at;
  const missingCanonicalizationUri = response();
  delete missingCanonicalizationUri.revisions[0].canonical_content_digest.canonicalization_uri;
  const missingRevisionContentSha256 = response();
  delete missingRevisionContentSha256.revisions[0].revision_content_sha256;
  const digestWithExtraField = response();
  digestWithExtraField.revisions[0].canonical_content_digest.untrusted_extra = true;
  const coverageWithExtraField = response();
  coverageWithExtraField.periods[0].coverage.untrusted_extra = true;
  const materializationWithExtraField = response();
  materializationWithExtraField.materializations[0].resource.untrusted_extra = true;
  const receiptWithExtraField = response();
  receiptWithExtraField.receipts[0].untrusted_extra = true;
  const validSummary = summaryResponse();
  const summaryMissingObligationCounts = summaryResponse();
  delete summaryMissingObligationCounts.obligation_counts;
  const validRevision = revisionResponse();
  const revisionMissingReceipts = revisionResponse();
  delete revisionMissingReceipts.receipts;
  const summaryIssueWithExtraField = summaryResponse();
  summaryIssueWithExtraField.health = 'delayed';
  summaryIssueWithExtraField.issues = [
    {
      issue_id: 'report-overdue-1',
      code: 'REPORT_OVERDUE',
      severity: 'delayed',
      responsible_party: 'seller',
      recommended_action: 'wait_for_retry',
      untrusted_extra: true,
    },
  ];
  const scopeWithExtraField = response();
  scopeWithExtraField.scope.untrusted_extra = true;
  const deliveryConfigGenerationWithExtraField = response();
  deliveryConfigGenerationWithExtraField.scope.delivery_config_generations[0].untrusted_extra = true;
  const obligationCountsWithExtraField = summaryResponse();
  obligationCountsWithExtraField.obligation_counts.untrusted_extra = true;
  const periodsPaginationMissingTotalCount = response();
  delete periodsPaginationMissingTotalCount.pagination.total_count;
  const revisionPaginationMissingTotalCount = revisionResponse();
  delete revisionPaginationMissingTotalCount.pagination.total_count;
  const paginationWithExtraField = response();
  paginationWithExtraField.pagination.untrusted_extra = true;
  const obligationWithExtraField = response();
  obligationWithExtraField.periods[0].untrusted_extra = true;
  const scheduleWithExtraField = response();
  scheduleWithExtraField.periods[0].schedule.untrusted_extra = true;
  const revisionWithExtraField = response();
  revisionWithExtraField.revisions[0].untrusted_extra = true;
  const revisionPeriodWithExtraField = response();
  revisionPeriodWithExtraField.revisions[0].period.untrusted_extra = true;
  const materializationWithExtraFieldAtRoot = response();
  materializationWithExtraFieldAtRoot.materializations[0].untrusted_extra = true;
  const verificationWithExtraField = response();
  verificationWithExtraField.materializations[0].verification.untrusted_extra = true;
  const controlTotalWithExtraField = response();
  controlTotalWithExtraField.revisions[0].control_totals[0].untrusted_extra = true;
  const validManifestChecksums = manifestChecksumsResponse();
  const physicalChecksumWithExtraField = manifestChecksumsResponse();
  physicalChecksumWithExtraField.materializations[0].verification.physical_checksums[0].untrusted_extra = true;

  const cases = [
    valid,
    missingMaterializations,
    missingCoverage,
    missingCoverageTimestamp,
    missingCanonicalizationUri,
    missingRevisionContentSha256,
    digestWithExtraField,
    coverageWithExtraField,
    materializationWithExtraField,
    receiptWithExtraField,
    validSummary,
    summaryMissingObligationCounts,
    validRevision,
    revisionMissingReceipts,
    summaryIssueWithExtraField,
    scopeWithExtraField,
    deliveryConfigGenerationWithExtraField,
    obligationCountsWithExtraField,
    periodsPaginationMissingTotalCount,
    revisionPaginationMissingTotalCount,
    paginationWithExtraField,
    obligationWithExtraField,
    scheduleWithExtraField,
    revisionWithExtraField,
    revisionPeriodWithExtraField,
    materializationWithExtraFieldAtRoot,
    verificationWithExtraField,
    controlTotalWithExtraField,
    validManifestChecksums,
    physicalChecksumWithExtraField,
  ];
  const validate = await authoritativeValidator();
  const authoritative = cases.map(value => validate(value));
  const generated = generatedOutcomes(cases);

  assert.deepEqual(authoritative, [
    true,
    ...Array(9).fill(false),
    true,
    false,
    true,
    false,
    ...Array(14).fill(false),
    true,
    false,
  ]);
  assert.deepEqual(generated, authoritative);
});
