import { z } from 'zod';
import {
  isReportingCanonicalDigest,
  isReportingControlTotals,
  isReportingReceiptEvidence,
  isReportingVerificationEvidence,
} from '../reporting/evidence';
import { isReportingCoverageEvidence } from '../reporting/reconciliation';

const SHA256_HEX = /^[A-Fa-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => value[field] !== undefined);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOffsetDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.includes('T') &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isReportingStatusIssue(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasFields(value, ['issue_id', 'code', 'severity', 'responsible_party', 'recommended_action'])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.issue_id) &&
    value.issue_id.length <= 255 &&
    /^[A-Za-z0-9_.:-]+$/.test(value.issue_id) &&
    [
      'REPORT_OVERDUE',
      'PRODUCTION_FAILED',
      'DELIVERY_FAILED',
      'ACCESS_REQUIRED',
      'CONFIGURATION_REQUIRED',
      'REPORTING_COVERAGE_INCOMPLETE',
      'RESOURCE_EXPIRED',
      'READER_INCOMPATIBLE',
      'HISTORY_UNAVAILABLE',
    ].includes(String(value.code)) &&
    ['delayed', 'action_required'].includes(String(value.severity)) &&
    ['buyer', 'seller', 'provider'].includes(String(value.responsible_party)) &&
    [
      'wait_for_retry',
      'contact_buyer',
      'contact_seller',
      'contact_provider',
      'repair_access',
      'update_configuration',
      'change_reporting_scope',
      'use_supported_reader',
    ].includes(String(value.recommended_action))
  );
}

function isReportingSchedule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = ['period_duration', 'alignment', 'delivery_sla'];
  const optional = ['period_anchor', 'period_timezone'];
  if (!hasFields(value, required) || !Object.keys(value).every(key => [...required, ...optional].includes(key)))
    return false;
  const periodDuration = /^P(?=.*[1-9])(?=\d|T)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
  const deliverySla = /^P(?=\d|T)(?=.*\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
  if (
    typeof value.period_duration !== 'string' ||
    !periodDuration.test(value.period_duration) ||
    !['utc', 'account_timezone', 'billing_cycle'].includes(String(value.alignment)) ||
    typeof value.delivery_sla !== 'string' ||
    !deliverySla.test(value.delivery_sla)
  )
    return false;
  return value.alignment === 'billing_cycle'
    ? isOffsetDateTime(value.period_anchor) &&
        isNonEmptyString(value.period_timezone) &&
        value.period_timezone.length <= 255
    : value.period_anchor === undefined && value.period_timezone === undefined;
}

function isReportingResource(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const required = ['resource_ref', 'kind', 'location', 'immutability', 'expires_at'];
  const optional = ['native_version_ref', 'manifest_version', 'manifest_sha256', 'reader_compatibility'];
  if (!hasFields(value, required) || !Object.keys(value).every(key => [...required, ...optional].includes(key)))
    return false;
  if (
    !isNonEmptyString(value.resource_ref) ||
    value.resource_ref.length > 255 ||
    !['manifest', 'dataset', 'warehouse_relation'].includes(String(value.kind)) ||
    !isNonEmptyString(value.location) ||
    value.location.length > 2048 ||
    !['immutable_location', 'native_version'].includes(String(value.immutability)) ||
    !isOffsetDateTime(value.expires_at) ||
    (value.reader_compatibility !== undefined &&
      (!Array.isArray(value.reader_compatibility) ||
        !value.reader_compatibility.every(isNonEmptyString) ||
        new Set(value.reader_compatibility).size !== value.reader_compatibility.length))
  )
    return false;
  if (
    value.kind === 'manifest' &&
    (value.manifest_version !== '1.0' ||
      typeof value.manifest_sha256 !== 'string' ||
      !SHA256_HEX.test(value.manifest_sha256))
  )
    return false;
  return value.immutability !== 'native_version' || isNonEmptyString(value.native_version_ref);
}

function isReportingMaterialization(value: unknown): boolean {
  const allowed = new Set([
    'reporting_materialization_id',
    'reporting_revision_id',
    'reporting_obligation_id',
    'delivery_config_id',
    'delivery_config_version',
    'destination_ref',
    'feed_purpose',
    'method',
    'transport',
    'attempt',
    'status',
    'ready_at',
    'failed_at',
    'failure_code',
    'resource',
    'verification',
    'created_at',
  ]);
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => !allowed.has(key)) ||
    !hasFields(value, [
      'reporting_materialization_id',
      'reporting_revision_id',
      'reporting_obligation_id',
      'delivery_config_id',
      'delivery_config_version',
      'destination_ref',
      'feed_purpose',
      'method',
      'attempt',
      'status',
      'created_at',
    ])
  ) {
    return false;
  }
  if (
    !isNonEmptyString(value.reporting_materialization_id) ||
    !isNonEmptyString(value.reporting_revision_id) ||
    !isNonEmptyString(value.reporting_obligation_id) ||
    !isNonEmptyString(value.delivery_config_id) ||
    !Number.isSafeInteger(value.delivery_config_version) ||
    Number(value.delivery_config_version) < 1 ||
    !isNonEmptyString(value.destination_ref) ||
    !['pacing', 'analytics', 'billing'].includes(String(value.feed_purpose)) ||
    !['file_transfer', 'dataset_share', 'warehouse_materialization'].includes(String(value.method)) ||
    (value.transport !== undefined &&
      (typeof value.transport !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.transport))) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !isOffsetDateTime(value.created_at)
  )
    return false;
  if (
    (value.resource !== undefined && !isReportingResource(value.resource)) ||
    (value.verification !== undefined && !isReportingVerificationEvidence(value.verification)) ||
    (value.ready_at !== undefined && !isOffsetDateTime(value.ready_at)) ||
    (value.failed_at !== undefined && !isOffsetDateTime(value.failed_at))
  )
    return false;
  if (!['pending', 'available', 'delivered', 'failed'].includes(String(value.status))) return false;
  if (value.status === 'failed') return isOffsetDateTime(value.failed_at) && isNonEmptyString(value.failure_code);
  if (value.status === 'pending') return true;
  if (
    !isOffsetDateTime(value.ready_at) ||
    !isReportingResource(value.resource) ||
    !isRecord(value.verification) ||
    !isReportingVerificationEvidence(value.verification)
  )
    return false;
  const resource = value.resource;
  const verification = value.verification;
  if (resource.immutability === 'native_version' && !isNonEmptyString(resource.native_version_ref)) return false;
  if (value.method === 'file_transfer') {
    return (
      resource.kind === 'manifest' &&
      resource.manifest_version === '1.0' &&
      typeof resource.manifest_sha256 === 'string' &&
      SHA256_HEX.test(resource.manifest_sha256) &&
      Array.isArray(verification.physical_checksums) &&
      verification.physical_checksums.length > 0
    );
  }
  if (value.method === 'dataset_share') {
    return resource.kind === 'dataset' && verification.verification_path === 'representative_consumer';
  }
  if (value.method === 'warehouse_materialization') {
    return resource.kind === 'warehouse_relation' && verification.verification_path === 'destination';
  }
  return false;
}

function isReportingReceipt(value: unknown): boolean {
  return isReportingReceiptEvidence(value);
}

function isReportingPeriod(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every(key => ['start', 'end', 'source_timezone'].includes(key)) &&
    isOffsetDateTime(value.start) &&
    isOffsetDateTime(value.end) &&
    isNonEmptyString(value.source_timezone)
  );
}

function isReportingObligation(value: unknown): boolean {
  const fields = [
    'reporting_obligation_id',
    'delivery_config_id',
    'delivery_config_version',
    'report_definition_id',
    'feed_purpose',
    'reporting_profile',
    'account_id',
    'scope_resolved_at',
    'media_buy_ids',
    'coverage',
    'period',
    'expected_at',
    'schedule',
    'destination_ref',
    'required_finality',
    'reconciliation_mode',
    'reconciliation_status',
    'health',
    'production_status',
    'revision_count',
    'materialization_count',
    'successful_materialization_count',
    'receipt_count',
    'accepted_receipt_count',
    'issues',
  ];
  if (!isRecord(value) || !hasFields(value, fields)) return false;
  return (
    isNonEmptyString(value.reporting_obligation_id) &&
    isNonEmptyString(value.delivery_config_id) &&
    Number.isInteger(value.delivery_config_version) &&
    Number(value.delivery_config_version) >= 1 &&
    isNonEmptyString(value.report_definition_id) &&
    ['pacing', 'analytics', 'billing'].includes(String(value.feed_purpose)) &&
    isNonEmptyString(value.reporting_profile) &&
    isNonEmptyString(value.account_id) &&
    isOffsetDateTime(value.scope_resolved_at) &&
    stringArray(value.media_buy_ids) &&
    isReportingCoverageEvidence(value.coverage) &&
    isReportingPeriod(value.period) &&
    isOffsetDateTime(value.expected_at) &&
    isReportingSchedule(value.schedule) &&
    isNonEmptyString(value.destination_ref) &&
    ['snapshot', 'official'].includes(String(value.required_finality)) &&
    ['delivery_only', 'consumer_receipt'].includes(String(value.reconciliation_mode)) &&
    ['not_required', 'pending', 'accepted', 'rejected'].includes(String(value.reconciliation_status)) &&
    ['waiting', 'healthy', 'delayed', 'action_required', 'complete'].includes(String(value.health)) &&
    ['not_due', 'pending', 'published', 'failed'].includes(String(value.production_status)) &&
    [
      'revision_count',
      'materialization_count',
      'successful_materialization_count',
      'receipt_count',
      'accepted_receipt_count',
    ].every(field => nonnegativeInteger(value[field])) &&
    Array.isArray(value.issues) &&
    value.issues.every(isReportingStatusIssue)
  );
}

function isCanonicalDigest(value: unknown): boolean {
  return isReportingCanonicalDigest(value);
}

function isReportingRevision(value: unknown): boolean {
  const fields = [
    'reporting_revision_id',
    'report_definition_id',
    'report_definition_uri',
    'report_definition_sha256',
    'reporting_profile',
    'schema_version',
    'schema_uri',
    'schema_sha256',
    'schema_dialect',
    'schema_ref_policy',
    'account_id',
    'media_buy_ids',
    'coverage',
    'period',
    'finality',
    'observed_at',
    'data_through',
    'data_through_precision',
    'row_count',
    'control_totals',
    'created_at',
  ];
  if (!isRecord(value) || !hasFields(value, fields)) return false;
  const officialFields = ['finality_basis', 'finality_policy_id', 'finalized_at'];
  const official = value.finality === 'official';
  if (official !== officialFields.every(field => value[field] !== undefined)) return false;
  if (!official && officialFields.some(field => value[field] !== undefined)) return false;
  if (
    official &&
    (!['source_final', 'contractual_cutoff', 'stabilized'].includes(String(value.finality_basis)) ||
      !isNonEmptyString(value.finality_policy_id) ||
      !isOffsetDateTime(value.finalized_at))
  ) {
    return false;
  }
  const precision = String(value.data_through_precision);
  if (
    !['exact', 'lower_bound', 'unknown'].includes(precision) ||
    (precision === 'unknown' ? value.data_through !== null : !isOffsetDateTime(value.data_through))
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.reporting_revision_id) &&
    isNonEmptyString(value.report_definition_id) &&
    isNonEmptyString(value.report_definition_uri) &&
    typeof value.report_definition_sha256 === 'string' &&
    SHA256_HEX.test(value.report_definition_sha256) &&
    isNonEmptyString(value.reporting_profile) &&
    isNonEmptyString(value.schema_version) &&
    isNonEmptyString(value.schema_uri) &&
    typeof value.schema_sha256 === 'string' &&
    SHA256_HEX.test(value.schema_sha256) &&
    value.schema_dialect === 'https://json-schema.org/draft/2020-12/schema' &&
    value.schema_ref_policy === 'local_fragment_only' &&
    isNonEmptyString(value.account_id) &&
    stringArray(value.media_buy_ids) &&
    isReportingCoverageEvidence(value.coverage) &&
    isReportingPeriod(value.period) &&
    ['snapshot', 'official'].includes(String(value.finality)) &&
    isOffsetDateTime(value.observed_at) &&
    nonnegativeInteger(value.row_count) &&
    isReportingControlTotals(value.control_totals) &&
    isOffsetDateTime(value.created_at) &&
    (value.canonical_content_digest === undefined || isCanonicalDigest(value.canonical_content_digest))
  );
}

const scopeKeys = [
  'period_start',
  'period_end',
  'scope_closed',
  'media_buy_ids',
  'all_accessible_media_buys',
  'delivery_config_generations',
  'feed_purposes',
  'finality',
  'ledger_retained_from',
  'coverage_complete',
];

function isReportingScope(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !Object.keys(value).every(key => scopeKeys.includes(key)) ||
    !hasFields(
      value,
      scopeKeys.filter(key => key !== 'media_buy_ids')
    )
  ) {
    return false;
  }
  const generations = value.delivery_config_generations;
  return (
    isOffsetDateTime(value.period_start) &&
    isOffsetDateTime(value.period_end) &&
    typeof value.scope_closed === 'boolean' &&
    typeof value.all_accessible_media_buys === 'boolean' &&
    (value.all_accessible_media_buys || stringArray(value.media_buy_ids)) &&
    Array.isArray(generations) &&
    generations.every(
      generation =>
        isRecord(generation) &&
        Object.keys(generation).every(key =>
          ['delivery_config_id', 'delivery_config_version', 'feed_purpose'].includes(key)
        ) &&
        isNonEmptyString(generation.delivery_config_id) &&
        Number.isInteger(generation.delivery_config_version) &&
        Number(generation.delivery_config_version) >= 1 &&
        ['pacing', 'analytics', 'billing'].includes(String(generation.feed_purpose))
    ) &&
    Array.isArray(value.feed_purposes) &&
    value.feed_purposes.every(item => ['pacing', 'analytics', 'billing'].includes(String(item))) &&
    Array.isArray(value.finality) &&
    value.finality.every(item => ['snapshot', 'official'].includes(String(item))) &&
    isOffsetDateTime(value.ledger_retained_from) &&
    typeof value.coverage_complete === 'boolean'
  );
}

function isPagination(value: unknown): boolean {
  return isRecord(value) && typeof value.has_more === 'boolean' && nonnegativeInteger(value.total_count);
}

function lacksFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => value[field] === undefined);
}

function hasCompletedCommon(value: Record<string, unknown>): boolean {
  return (
    value.status === 'completed' &&
    isNonEmptyString(value.ledger_snapshot_id) &&
    isOffsetDateTime(value.ledger_as_of) &&
    isNonEmptyString(value.account_id)
  );
}

function isSummaryResponse(value: Record<string, unknown>): boolean {
  if (!isRecord(value.obligation_counts)) return false;
  const obligationCounts = value.obligation_counts;
  if (
    !hasCompletedCommon(value) ||
    value.view !== 'summary' ||
    !isReportingScope(value.scope) ||
    !isReportingCoverageEvidence(value.coverage) ||
    !(value.data_through === null || isOffsetDateTime(value.data_through)) ||
    !lacksFields(value, ['periods', 'revisions', 'pagination', 'revision', 'materializations', 'receipts']) ||
    !['healthy', 'waiting', 'delayed', 'action_required', 'complete'].includes(String(value.health)) ||
    !Array.isArray(value.issues) ||
    !value.issues.every(isReportingStatusIssue) ||
    !['total', 'waiting', 'healthy', 'delayed', 'action_required', 'complete'].every(field =>
      nonnegativeInteger(obligationCounts[field])
    )
  ) {
    return false;
  }
  const health = String(value.health);
  if (
    health === 'complete' &&
    (!value.scope.scope_closed || !value.scope.coverage_complete || value.next_expected_at !== undefined)
  ) {
    return false;
  }
  if (['healthy', 'waiting', 'complete'].includes(health) && value.issues.length !== 0) return false;
  if (
    health === 'action_required' &&
    !value.issues.some(issue => isRecord(issue) && issue.severity === 'action_required')
  ) {
    return false;
  }
  if (
    health === 'delayed' &&
    (value.issues.length === 0 || value.issues.some(issue => !isRecord(issue) || issue.severity !== 'delayed'))
  ) {
    return false;
  }
  if (
    !value.scope.coverage_complete &&
    (health !== 'action_required' ||
      !value.issues.some(
        issue => isRecord(issue) && issue.code === 'HISTORY_UNAVAILABLE' && issue.severity === 'action_required'
      ))
  ) {
    return false;
  }
  return true;
}

function isGetReportingStatusResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === 'failed') {
    const allowed = new Set([
      'adcp_version',
      'adcp_major_version',
      'status',
      'view',
      'failure_kind',
      'context_id',
      'context',
      'message',
      'timestamp',
      'replayed',
      'adcp_error',
      'errors',
    ]);
    if (
      Object.keys(value).some(key => !allowed.has(key)) ||
      !['summary', 'periods', 'revision'].includes(String(value.view)) ||
      !['lookup_unavailable', 'operational'].includes(String(value.failure_kind)) ||
      !Array.isArray(value.errors) ||
      value.errors.length === 0 ||
      !value.errors.every(error => isRecord(error) && isNonEmptyString(error.code) && isNonEmptyString(error.message))
    )
      return false;
    if (value.failure_kind === 'lookup_unavailable') {
      return (
        value.errors.length === 1 &&
        Object.keys(value.errors[0]).every(key => ['code', 'message'].includes(key)) &&
        value.errors[0].code === 'NOT_FOUND' &&
        value.errors[0].message === 'Reporting status resource is unavailable.' &&
        (value.message === undefined || value.message === 'Reporting status resource is unavailable.') &&
        (value.adcp_error === undefined ||
          (isRecord(value.adcp_error) &&
            Object.keys(value.adcp_error).every(key => ['code', 'message'].includes(key)) &&
            value.adcp_error.code === 'NOT_FOUND' &&
            value.adcp_error.message === 'Reporting status resource is unavailable.'))
      );
    }
    return true;
  }
  if (value.status !== 'completed') return false;
  if (value.view === 'summary') return isSummaryResponse(value);
  if (value.view === 'periods') {
    return (
      hasCompletedCommon(value) &&
      isReportingScope(value.scope) &&
      Array.isArray(value.periods) &&
      value.periods.every(isReportingObligation) &&
      Array.isArray(value.revisions) &&
      value.revisions.every(isReportingRevision) &&
      Array.isArray(value.materializations) &&
      value.materializations.every(isReportingMaterialization) &&
      Array.isArray(value.receipts) &&
      value.receipts.every(isReportingReceipt) &&
      isPagination(value.pagination) &&
      lacksFields(value, ['revision'])
    );
  }
  if (value.view === 'revision') {
    return (
      hasCompletedCommon(value) &&
      isReportingRevision(value.revision) &&
      Array.isArray(value.materializations) &&
      value.materializations.every(isReportingMaterialization) &&
      Array.isArray(value.receipts) &&
      value.receipts.every(isReportingReceipt) &&
      isPagination(value.pagination) &&
      lacksFields(value, ['scope', 'health', 'periods', 'revisions'])
    );
  }
  return false;
}

export const GetReportingStatusResponseCurrentSchema: z.ZodType = z.custom(isGetReportingStatusResponse, {
  message: 'get_reporting_status response does not satisfy the current reporting protocol',
});
