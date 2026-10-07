import { canonicalize } from '../../utils/jcs';
import type { ReportingManagedDeliveryAdapterV1 } from '../ledger/managed';
import type { ExpectedReportingPeriod } from '../reconciliation';
import { ReportingGcsFenceError } from './errors';
type DeliveryInput = Parameters<ReportingManagedDeliveryAdapterV1['deliver']>[0];

export function assertExpectedBinding(input: DeliveryInput, expected: ExpectedReportingPeriod): void {
  const {
    binding,
    revision: { wireRevision: r },
    obligation,
  } = input;
  const shaMatches = (a: string | undefined, b: string) =>
    typeof a === 'string' &&
    /^[a-fA-F0-9]{64}$/.test(a) &&
    /^[a-fA-F0-9]{64}$/.test(b) &&
    a.toLowerCase() === b.toLowerCase();
  if (
    expected.verificationProfile !== binding.verification_profile ||
    expected.destinationRef !== binding.destination_ref ||
    expected.deliveryMethod !== binding.method ||
    expected.deliveryConfigId !== binding.delivery_config_id ||
    expected.deliveryConfigVersion !== binding.delivery_config_version ||
    expected.reportDefinitionId !== r.report_definition_id ||
    expected.feedPurpose !== binding.feed_purpose ||
    expected.reportingProfile !== r.reporting_profile ||
    expected.reconciliationMode !== binding.reconciliation_mode ||
    expected.requiredFinality !== obligation.requiredFinality ||
    expected.periodStart !== r.period.start ||
    expected.periodEnd !== r.period.end ||
    canonicalize([...expected.mediaBuyIds].sort()) !== canonicalize([...r.media_buy_ids].sort()) ||
    expected.reportDefinitionUri !== r.report_definition_uri ||
    !shaMatches(r.report_definition_sha256, expected.reportDefinitionSha256) ||
    expected.schemaUri !== r.schema_uri ||
    !shaMatches(r.schema_sha256, expected.schemaSha256) ||
    expected.schemaVersion !== r.schema_version ||
    expected.schemaDialect !== r.schema_dialect ||
    expected.schemaRefPolicy !== r.schema_ref_policy ||
    (r.finality === 'official' &&
      (!expected.officialFinality ||
        expected.officialFinality.policyId !== r.finality_policy_id ||
        expected.officialFinality.basis !== r.finality_basis))
  )
    throw new ReportingGcsFenceError('CONTENT_CONFLICT');
  const coverage = (value: typeof expected.coverage) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['evaluated_at', 'limitations'].includes(key))
        .map(([key, item]) => [key, Array.isArray(item) ? [...item].sort() : item])
    );
  if (canonicalize(coverage(expected.coverage)) !== canonicalize(coverage(r.coverage)))
    throw new ReportingGcsFenceError('CONTENT_CONFLICT');
  if (expected.verificationProfile === 'canonical_digest') {
    const pin = expected.canonicalization,
      digest = r.canonical_content_digest;
    if (
      !digest ||
      digest.canonicalization_id !== pin.id ||
      digest.canonicalization_uri !== pin.uri ||
      !shaMatches(digest.canonicalization_sha256, pin.sha256)
    )
      throw new ReportingGcsFenceError('CONTENT_CONFLICT');
  }
}
